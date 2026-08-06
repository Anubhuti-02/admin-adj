# Email Alert Setup – Quick Guide

1. **Install nodemailer**
   ```bash
   npm install nodemailer
   ```

2. **Enable 2-Factor Authentication** on your Gmail account
   Google Account → Security → 2-Step Verification → ON

3. **Generate an App Password**
   App passwords → select **Mail** and **Other (custom name)** → Generate → copy the 16-character password

4. **Add to `.env`** (in your server directory)
   ```ini
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx   # app password
   SMTP_FROM=your-email@gmail.com
   ```

5. **Restart server**
   ```bash
   node server.js
   ```

6. **Configure recipients** via the UI — click the bell icon → Email Settings → add comma-separated emails

7. **Test** — trigger an impact or use `/api/test-email` (if available). Check the Spam folder too.

---

Use the same email for `SMTP_USER` and `SMTP_FROM`.
Supports multiple recipients — separate by commas.
If Gmail fails, try SendGrid/Mailgun — just change the SMTP settings.
