# opencourt-frontend

Static frontend for [OpenCourt](https://opencourt.fourallthedogs.com) — a sport-agnostic court availability tracker for Houston. Hosted on S3, served via CloudFront.

---

## What It Does

- Displays 2,671 Houston basketball, tennis, and pickleball courts on an interactive Leaflet.js map
- Shows real-time court availability via color-coded pins (green = available, red = in use)
- Allows anonymous users to report court status
- Authenticated users can check in, check out, and track stats/badges/streaks
- Profile panel shows full name, courts visited, hours played, day streak, total check-ins, and earned badges

---

## Project Structure

```
opencourt-frontend/
├── index.html          # Main map UI
├── script.js           # Leaflet map, Cognito auth, API calls, profile panel
├── login.html          # Sign in / Create account / Email verification
└── .github/workflows/
    └── deploy.yml      # Pulls SSM config, injects into HTML, syncs to S3, invalidates CloudFront
```

---

## Auth Flow

1. User signs up with full name, username, email, password on `login.html`
2. Cognito sends verification code to email
3. After verification, auto signs in and redirects to map
4. On load, `script.js` calls `GET /users/me` to create the user row, then `PUT /users/me` to save full name
5. Full name displays in the nav pill and profile panel

Uses `amazon-cognito-identity-js` SDK. Sends **access tokens** (not ID tokens) to the API.

---

## CI/CD

Push to `main` → GitHub Actions:
1. Pulls `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_IDENTITY_POOL_ID` from SSM Parameter Store
2. Injects them as `window.*` variables into `index.html` and `login.html`
3. Syncs all files to the S3 frontend bucket
4. Invalidates the CloudFront distribution cache

---

## Local Development

Open `index.html` directly in a browser. The `CONFIG` object falls back to hardcoded values if `window.*` variables aren't injected:

```js
const CONFIG = {
  API_URL:               window.API_URL               || 'https://api.opencourt.fourallthedogs.com',
  COGNITO_USER_POOL_ID:  window.COGNITO_USER_POOL_ID  || 'REPLACE_AFTER_APPLY',
  COGNITO_CLIENT_ID:     window.COGNITO_CLIENT_ID      || 'REPLACE_AFTER_APPLY',
  COGNITO_IDENTITY_POOL: window.COGNITO_IDENTITY_POOL  || 'REPLACE_AFTER_APPLY',
};
```

Replace the `REPLACE_AFTER_APPLY` values with your actual Cognito IDs from Terraform outputs for local testing.

---

## Critical Gotchas

**Full name save order** — In `script.js` `init()`, `GET /users/me` must run before `PUT /users/me`. The GET creates the user row on first login. If PUT runs first, it updates 0 rows silently and the name is never saved.

**Cognito config injection** — After every `terraform destroy` + apply, Cognito gets new IDs. Push to GitHub to trigger CI/CD which pulls fresh values from SSM. Don't hardcode Cognito IDs directly in the HTML.

**Access token not ID token** — The API validates `tokenUse: 'access'`. Always use `session.getAccessToken().getJwtToken()`, not `session.getIdToken().getJwtToken()`.
