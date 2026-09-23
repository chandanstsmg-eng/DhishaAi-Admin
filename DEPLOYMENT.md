# Deploying the Dhishaai Admin Portal

For whoever installs and looks after this on the company server. It assumes
Windows Server and no prior knowledge of the app.

---

## Before you start

| Need | Detail |
|---|---|
| Node.js | **22.5 or newer** (24 LTS recommended). `node --version` to check. |
| Disk | ~200 MB, plus room for backups. The database is a single file. |
| Port | 4000 by default, changeable. |
| Rights | Local administrator, for the service and scheduled task. |

There is no `npm install` step. The app has zero runtime dependencies.

---

## 1. Copy the app

Put the folder somewhere permanent and out of a user profile, e.g.
`C:\Apps\dhishaai-admin`. A path under `Downloads` or `Desktop` will bite you
later — profiles get roamed, cleaned and redirected.

```powershell
Copy-Item -Recurse .\dhishaai-admin C:\Apps\dhishaai-admin
cd C:\Apps\dhishaai-admin
```

Sanity check before installing anything as a service:

```powershell
npm start
```

Open <http://localhost:4000>, sign in, press `Ctrl+C`.

---

## 2. Install as a service

```powershell
# from an elevated PowerShell, in the app folder
.\deploy\install-service.ps1 -Port 4000
```

This starts the portal at boot, before anyone logs in, and restarts it if it
fails. It uses **NSSM** if present (`choco install nssm`) and otherwise
registers a **Scheduled Task** running as SYSTEM — both work; NSSM gives nicer
log rotation and `services.msc` integration.

It prints a generated `DHISHAAI_SECRET` and writes it to `deploy\SECRET.txt`.

> **Save that secret in your password manager, then delete the file.** It
> encrypts the stored mail password. Lose it and you re-enter that password;
> leak it and the encryption was pointless.

Behind a TLS reverse proxy, add the flags in step 3 instead.

Check it:

```powershell
Get-Service DhishaaiAdmin            # or: Get-ScheduledTask DhishaaiAdmin
Invoke-WebRequest http://localhost:4000/ -UseBasicParsing | Select-Object StatusCode
```

---

## 3. Put HTTPS in front of it

**Do this before anyone signs in over the network.** Without it the session
cookie crosses the LAN in the clear, and anyone who captures one is an admin.
The app does not terminate TLS itself — put IIS, nginx or Caddy in front.

Caddy is the shortest path; this is the entire config, certificate included:

```
portal.yourcompany.com {
    reverse_proxy localhost:4000
}
```

For IIS: install **URL Rewrite** + **Application Request Routing**, bind your
certificate to 443, and reverse-proxy `/` to `http://localhost:4000/`. Make sure
it forwards `X-Forwarded-Proto`.

Then reinstall the service so it knows it is behind TLS:

```powershell
.\deploy\install-service.ps1 -Port 4000 -TrustProxy -SecureCookies -Hsts `
    -Secret '<the secret you saved>'
```

| Flag | Effect |
|---|---|
| `-TrustProxy` | Believe `X-Forwarded-Proto` / `X-Forwarded-For`. **Only with a proxy in front** — otherwise a client can forge them. |
| `-SecureCookies` | Session cookie gets `Secure`, so the browser never sends it over plain HTTP. |
| `-Hsts` | Send `Strict-Transport-Security`. Turn on once HTTPS works — browsers remember it. |

Finally, stop the portal answering on plain HTTP from the network. Leave it
bound to localhost for the proxy, and let the proxy hold 80/443:

```powershell
New-NetFirewallRule -DisplayName 'Block direct portal port' -Direction Inbound `
    -LocalPort 4000 -Protocol TCP -Action Block
```

---

## 4. Lock down the data directory

```powershell
.\deploy\harden-permissions.ps1
# or, to keep a group's access:
.\deploy\harden-permissions.ps1 -AlsoAllow 'DOMAIN\ITAdmins'
```

Strips inherited permissions from `data\` so only SYSTEM and Administrators can
read it. That folder holds every student record and the encryption key.

---

## 5. Schedule backups

```powershell
.\deploy\schedule-backup.ps1 -At 02:00 -OffsiteDir '\\fileserver\backups\dhishaai'
```

Daily at 02:00, keeping the last 30 copies offsite and the last 20 locally.

**`-OffsiteDir` is the part that matters.** Without it the copies sit on the
same disk as the original, which protects you from a bad import but not from the
drive failing or the machine being encrypted. The script also copies
`data\.secret-key` alongside — a backup without it restores the records but not
the mail password.

Restore is under **Settings → Data → Restore**, or swap the `.db` file back in
with the service stopped.

---

## 6. First sign-in

```
email     admin@dhishaai.com
password  dhishaai@2026
```

**Change this before the portal is reachable by anyone else** —
Settings → Users. It is published in the README, so treat it as public
knowledge. Then create a named account per staff member; shared logins make the
audit log useless.

Roles: `owner` (everything) · `admin` (all but owner accounts) · `accounts`
(fees, payments, expenses) · `counsellor` (enquiries, admissions) · `staff`
(attendance, tasks).

---

## Configuration reference

Set as service environment variables (the install script handles the common
ones).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Listening port. |
| `DHISHAAI_SECRET` | key file | Encrypts stored credentials. Prefer this over the on-disk key. |
| `DHISHAAI_DB` | `data\dhishaai.db` | Database location. |
| `TRUST_PROXY` | off | Honour `X-Forwarded-*`. Only behind a proxy. |
| `SECURE_COOKIES` | off | Force `Secure` on session cookies. |
| `HSTS` | off | Send HSTS on HTTPS responses. |
| `LOGIN_MAX_FAILS` | `10` | Failed sign-ins before a lockout. |
| `LOGIN_WINDOW_MIN` | `15` | Lockout window, minutes. |
| `STAY_UP` | off | `1` = log faults and keep running instead of restarting. Only without a supervisor. |

---

## Operating it

```powershell
Get-Service DhishaaiAdmin
Restart-Service DhishaaiAdmin
Get-Content .\logs\service.log -Tail 50 -Wait
Get-Content .\logs\service-error.log -Tail 50

npm run backup            # manual backup, any time
```

**Health check** — `GET /api/auth/me` returns 200 with `{"user":null}` when
signed out, so it works as an unauthenticated probe for a monitor.

### If it will not start

| Symptom | Cause |
|---|---|
| `Port 4000 is already in use` | Another copy is running. `Get-NetTCPConnection -LocalPort 4000` |
| `Could not open a SQLite driver` | Node older than 22.5. |
| Service starts then stops | Read `logs\service-error.log`. Usually the data folder is not writable by SYSTEM. |
| Sign-in never sticks | `SECURE_COOKIES=1` but the browser reached it over plain HTTP. |

### Scale

SQLite plus single-threaded Node comfortably handles an institute-sized load —
measured at 100 concurrent requests in 175 ms on this hardware, with concurrent
writes all committing. **Do not run two instances against one database** and do
not put it behind a load balancer; SQLite expects a single writer.

---

## Deployment checklist

- [ ] Node 22.5+ confirmed
- [ ] App in a permanent path outside any user profile
- [ ] Runs by hand (`npm start`) before installing the service
- [ ] Service installed, survives a reboot
- [ ] `DHISHAAI_SECRET` saved to the password manager, `deploy\SECRET.txt` deleted
- [ ] HTTPS proxy in front, `-TrustProxy -SecureCookies -Hsts` set
- [ ] Direct port blocked at the firewall
- [ ] `harden-permissions.ps1` run
- [ ] Backups scheduled **with an offsite target**
- [ ] One restore rehearsed from a backup file
- [ ] **Default password changed**
- [ ] Named account per staff member
