# PlotAxis Customer Portal — Setup Guide (Frontend + Backend + MySQL + Email)

## Folder Contents
- `index.html` — Customer portal UI (Login, Register, OTP Verification & Dashboard)
- `styles.css` — Complete styling
- `app.js` — Customer portal logic and reservation synchronization
- `data.js` — Plot inventory & recommendation scoring
- `server.js` — Node.js + Express backend with MySQL & Nodemailer OTP
- `database.sql` — MySQL database & tables script
- `package.json` — Required Node.js packages
- `.env` — Database & Gmail SMTP configuration

---

## Step 1: MySQL Database Import Karein
1. Apna **XAMPP** (Apache & MySQL) ya **MySQL Workbench** start karein.
2. `database.sql` file ko import karein ya uski SQL queries run karein. Is se `plotaxis_db` database aur `users` + `otp_codes` tables ban jayenge.

## Step 2: `.env` File Configure Karein
1. `.env` file ko VS Code mein open karein.
2. Agar aapke MySQL ka password hai to `DB_PASSWORD=` ke aage likhein (XAMPP mein khali rehta hai).
3. `EMAIL_USER` mein apna Gmail address likhein (yeh system ka sender email hoga).
4. `EMAIL_PASS` mein apna **16-digit Google App Password** likhein:
   - Google Account -> Security -> 2-Step Verification ON karein -> App Passwords mein ja kar naya password generate karein.
5. `ADMIN_API_KEY` mein ek strong, private key set karein. Is key se admins payments verify, one-time 24-hour extensions approve, aur Society Verification documents manage karenge. Key missing ho to admin endpoints band rahenge. Isay customers ke saath share na karein.

## Step 3: Packages Install Karein aur Server Chalayein
VS Code terminal mein is folder ke andar yeh 2 commands chalayein:

```bash
npm install
npm start
```

Server start hone par likha aayega:
`PlotAxis Server running on http://localhost:5000`

## Step 4: Reservation Expiry
- Nayi reservation par 72-hour payment deadline database mein save hoti hai.
- Payment verify na hone par 24 aur 48 hours ke baad reminder emails bheje jate hain; 72 hours par reservation cancel hoti hai aur plot phir available ho jata hai.
- Payment verify hote hi expiry ruk jati hai. Admin har reservation ko sirf ek baar 24-hour extension de sakta hai.
- Customer cancellation request ke 5 minutes baad booking cancel hoti hai aur plot available ho jata hai.
- Server har 10 seconds mein due cancellations, reminders aur expiries check karta hai. `plot_reservations` table server startup par khud create ho jati hai; `database.sql` mein bhi iska schema shamil hai.

Admins `.env` mein configured key `x-admin-key` header ke zariye bhejein. Pending reservations dekhne ke liye:

```bash
curl -H "x-admin-key: YOUR_ADMIN_API_KEY" http://localhost:5000/api/admin/reservations
```

Payment milne ke baad `BOOKING_ID` ke liye payment verify karein:

```bash
curl -X POST -H "x-admin-key: YOUR_ADMIN_API_KEY" http://localhost:5000/api/admin/reservations/BOOKING_ID/payment-verified
```

24-hour extension approve karne ke liye:

```bash
curl -X POST -H "x-admin-key: YOUR_ADMIN_API_KEY" http://localhost:5000/api/admin/reservations/BOOKING_ID/extension
```

Payment verify aur extension approval manual admin actions hain; customer portal ka existing design nahi badla gaya.

## Step 5: Portal Open Karein
Browser mein **`http://localhost:5000`** open karein.
- Koi bhi naya user **Create account** karega to OTP **usi user ke apne email** par jayega!

## Society Verification Documents
- Customer ke Society verification page par registration certificate, NOC, approved layout plan aur land ownership documents ki metadata aur verification status dikhte hain.
- Customer document file sirf authenticated API se, admin verification ke baad dekh sakta hai. Original files MySQL mein hain aur admin-only endpoint se milti hain; ye public static folder mein save nahi hotin.
- Admin actions `x-admin-key` se protected hain. Upload format PDF, PNG ya JPEG hai; maximum size 20 MB.

Pehle metadata record banayein:

```bash
curl -X POST http://localhost:5000/api/admin/certificates \
  -H "x-admin-key: YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"societyName\":\"Silver Valley\",\"documentType\":\"noc\",\"title\":\"Society NOC\",\"issuingAuthority\":\"Development Authority\",\"approvalNumber\":\"NOC-123\"}"
```

Response ke `id` se file upload karein, phir verify karein:

```bash
curl -X PUT http://localhost:5000/api/admin/certificates/ID/file \
  -H "x-admin-key: YOUR_ADMIN_API_KEY" \
  -H "x-file-name: society-noc.pdf" \
  -H "Content-Type: application/pdf" \
  --data-binary "@society-noc.pdf"

curl -X POST http://localhost:5000/api/admin/certificates/ID/verify \
  -H "x-admin-key: YOUR_ADMIN_API_KEY"
```

Metadata update karne ke liye `PUT /api/admin/certificates/ID` par JSON body bhejein. File replace ya metadata update se status `pending` ho jata hai; dobara verify karna zaroori hai. Reject karne ke liye `POST /api/admin/certificates/ID/reject` par `{"reason":"..."}` bhejein. Original file admin-only `GET /api/admin/certificates/ID/file` se milti hai. Admin `GET /api/admin/certificates/ID/views` se customer/admin viewing activity dekh sakta hai.

Portal viewer download/print controls provide nahi karta, right-click aur common save/print shortcuts ko block karta hai, aur view-time watermark lagata hai. Browser/device-level screenshots ko poori tarah rokna mumkin nahi.
