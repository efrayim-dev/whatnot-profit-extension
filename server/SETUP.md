# Cloud Server Setup Guide

Step-by-step plan for deploying the 24/7 tracking server on a VPS.

## 1. Pick a VPS provider

Any of these work. Get the cheapest plan with 1GB+ RAM:

- **Hetzner** — $3.79/month (best value, EU or US datacenters)
  https://www.hetzner.com/cloud
- **DigitalOcean** — $6/month (most beginner-friendly)
  https://www.digitalocean.com
- **Vultr** — $5/month
  https://www.vultr.com

Choose **Ubuntu 22.04** as the OS when creating the server.

## 2. Connect to the server

After creating the VPS, you'll get an IP address and password (or SSH key).

```
ssh root@YOUR_SERVER_IP
```

## 3. Install Docker

```
curl -fsSL https://get.docker.com | sh
```

## 4. Clone the repo

```
git clone https://github.com/efrayim-dev/whatnot-profit-extension.git
cd whatnot-profit-extension
git checkout analytics
```

## 5. Log in to Whatnot (one-time)

This needs to happen on YOUR computer (not the server) since you need a browser window to log in.

On your PC, in the `whatnot-profit-extension` folder:

```
cd server
npm install
npm run login
```

A browser opens. Log in to Whatnot. Close the browser when done.

Now copy the saved session to the server:

```
scp -r server/browser-profile root@YOUR_SERVER_IP:/root/whatnot-profit-extension/server/
```

## 6. Start the server

SSH back into the server:

```
cd /root/whatnot-profit-extension/server
docker compose up -d
```

Verify it's running:

```
curl http://localhost:3000/status
```

## 7. Start tracking a show

When a show is about to start, send:

```
curl -X POST http://YOUR_SERVER_IP:3000/watch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.whatnot.com/live/YOUR_SHOW_ID"}'
```

You can find the show URL from Whatnot — it's the link you'd share with buyers.

## 8. Check on it

- **Status**: `curl http://YOUR_SERVER_IP:3000/status`
- **Screenshot**: Open `http://YOUR_SERVER_IP:3000/screenshot` in your browser to see what it sees
- **Stop**: `curl -X POST http://YOUR_SERVER_IP:3000/stop`

## 9. View your data

Everything syncs to Google Sheets automatically (same webhook as the browser extension).

## Ongoing maintenance

- **Session expired?** Re-run steps 5-6 (login on PC, copy profile to server)
- **Server restarted?** Docker auto-restarts the container (`restart: unless-stopped`)
- **Update the extension?** On the server: `git pull && docker compose up -d --build`
- **Logs**: `docker compose logs -f` to see what the extension is doing

## Security note

The API is open on port 3000 with no authentication. If you want to lock it down:
- Use a firewall to only allow your IP: `ufw allow from YOUR_HOME_IP to any port 3000`
- Or put it behind a reverse proxy with basic auth

## Cost

~$4-6/month for the server. No other costs — Google Sheets is free, the extension is free.
