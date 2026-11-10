# Connecting the Wix website

The Wix site stays the customer-facing marketing site. Its forms post to this app **from Wix backend code**, so the shared secret is never sent to a browser.

```
Visitor fills a Wix form ──► Wix backend (Velo, http function / onSubmit handler)
                              │  POST + Authorization: Bearer <secret>
                              ▼
     https://<your-app>.netlify.app/api/integrations/wix/service-request
                              │
     find-or-create customer (by email / phone) → save address as a property →
     service request SR-000123 → notify customer service → (optional) confirmation email/SMS
```

## 1. Configure the app (Netlify)

1. Generate a long random secret, for example by running `openssl rand -hex 32`.
2. In Netlify, under **Site configuration → Environment variables**, add `WIX_WEBHOOK_SECRET=<that secret>`.
3. Redeploy. Company Settings → Integrations should now show "Wix website forms: Configured".
4. Optional: to have customers sent a confirmation email or text, set `RESEND_API_KEY` + `MAIL_FROM` and/or `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM_NUMBER`. Then tick "Email/text the customer a confirmation" in Company Settings → Automations.

## 2. Configure Wix

1. In the Wix editor, turn on **Dev Mode** (Velo).
2. Under **Secrets Manager**, add a secret named `HVAC_WEBHOOK_SECRET` with the same value.
3. Create `backend/hvac.web.js`:

```js
import { Permissions, webMethod } from 'wix-web-module';
import { fetch } from 'wix-fetch';
import { getSecret } from 'wix-secrets-backend';

const ENDPOINT = 'https://YOUR-APP.netlify.app/api/integrations/wix/service-request';

export const submitServiceRequest = webMethod(Permissions.Anyone, async (form) => {
  const secret = await getSecret('HVAC_WEBHOOK_SECRET');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(form),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data.requestNumber; // e.g. "SR-000123" - show it on the thank-you message
});
```

4. On each form page (Request Service, Schedule Service, Request an Estimate, Emergency), call it from the page code:

```js
import { submitServiceRequest } from 'backend/hvac.web';

$w('#submitButton').onClick(async () => {
  const number = await submitServiceRequest({
    name: $w('#name').value,
    email: $w('#email').value,
    phone: $w('#phone').value,
    address: $w('#address').value,
    city: $w('#city').value,
    state: $w('#state').value,
    zip: $w('#zip').value,
    requestType: 'service',            // 'service' | 'estimate' | 'maintenance' | 'emergency' | 'warranty' | 'complaint'
    message: $w('#details').value,
    preferredDate: $w('#date').value,  // YYYY-MM-DD, optional
    preferredTime: $w('#time').value,  // optional
    accountType: 'residential',        // or 'commercial'
    submissionId: crypto.randomUUID(), // makes retries safe (no duplicates)
    website: $w('#hp').value,          // hidden honeypot field; leave empty
  });
  $w('#thanks').text = `Thanks! Your request number is ${number}. We'll call you shortly.`;
});
```

If you'd rather keep Wix's built-in form app, the same `submitServiceRequest(...)` call can go in the form's backend submission event instead.

## Request and response

| Field | Required | Notes |
| --- | --- | --- |
| `name` (or `firstName` + `lastName`) | yes | |
| `email` / `phone` | at least one | used for de-duplication (email, or the last 10 phone digits) |
| `address`, `city`, `state`, `zip` | no | saved as a property; reused if the same address already exists |
| `requestType` | no | `service`, `estimate` / `quote`, `maintenance`, `emergency`, `warranty`, `complaint`; anything else becomes `service` |
| `message`, `preferredDate`, `preferredTime`, `accountType`, `companyName` | no | |
| `submissionId` | recommended | the same id twice returns the original request, so no duplicate is created |

Responses:

* `201 {ok:true, requestNumber}`: created.
* `200 {ok:true, duplicate:true}`: a retry of a request already received.
* `400`: validation error.
* `401`: wrong secret.
* `429`: rate limited.
* `503`: `WIX_WEBHOOK_SECRET` is not set on the server.

## Homepage content

The marketing site itself (branding, hero, service pages, financing, testimonials, service area) is built in the Wix editor; this repository cannot edit a Wix site. Suggested structure:

1. Hero with the main call to action ("Schedule Service") and a 24/7 emergency phone number.
2. Three buttons: Request Service, Request an Estimate, Emergency Service. Each opens a form wired as above, with a different `requestType`.
3. Residential, Commercial, Heating, Cooling, Maintenance Plans, Financing.
4. Testimonials, About Us, service-area map, contact details.
