# PlotAxis Final Year Project

PlotAxis is a housing society management portal for plot bookings and installment tracking.

## Project structure

- `Admin_portal/` — admin payment portal
- `customer_portal/` — customer login, bookings, payments and society pages
- `server.js` — shared Express API serving both portals
- `database.sql` — MySQL schema

## Run locally

From this folder, run `npm install`, configure `.env`, then run `npm start`.
The app opens at `http://localhost:5000`; the admin portal is at
`http://localhost:5000/admin.html`.
