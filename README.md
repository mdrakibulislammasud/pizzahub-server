# PizzaHub Server — Backend API

The PizzaHub backend provides API services for authentication, user and role management, menu items, customer orders, vendor subscriptions, and platform transactions.

## Live API

https://pizzahub-server-git-main-diligent3.vercel.app/

## GitHub Repositories

- **Server:** https://github.com/mdrakibulislammasud/pizzahub-server
- **Client:** https://github.com/mdrakibulislammasud/pizzahub-client
- **Live frontend:** https://pizzahub-client-zeta.vercel.app/

## Technology Stack

- Node.js
- Express 5
- TypeScript
- MongoDB 7
- Better Auth and MongoDB adapter
- JOSE for JWT verification
- Stripe Checkout and webhooks
- Zod for validation
- Multer
- ImgBB image hosting
- dotenv
- CORS

## Main Responsibilities

- Authentication and user management through Better Auth.
- Role-based authorization for Customers, Vendors, and Admins.
- MongoDB data management for users, menu items, orders, and transactions.
- Menu item creation, updating, deletion, approval, and filtering.
- Customer order management and ownership validation.
- Vendor Premium subscription checkout using Stripe.
- Stripe webhook processing for subscription payment events.
- Image upload handling for menu items.
- Protected API endpoints and request validation.

## Requirements

- Node.js 20.9 or later
- npm
- MongoDB database
- ImgBB API key
- Stripe account and webhook configuration
- Google OAuth credentials if Google sign-in is enabled

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/mdrakibulislammasud/pizzahub-server.git
cd pizzahub-server
npm install
```

### 2. Configure environment variables

Create a `.env` file in the server root directory. Use `.env.example` as the variable-name reference.

| Variable | Purpose |
|---|---|
| `PORT` | Express server port |
| `NODE_ENV` | Runtime environment |
| `CLIENT_URL` | Allowed frontend origin for CORS |
| `MONGODB_URI` | MongoDB connection string |
| `DB_NAME` | MongoDB database name |
| `BETTER_AUTH_SECRET` | Better Auth secret |
| `BETTER_AUTH_URL` | Backend Better Auth base URL |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `JWT_SECRET` | JWT signing or verification configuration |
| `IMGBB_API_KEY` | ImgBB API key |
| `STRIPE_SECRET_KEY` | Stripe private API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe Premium subscription price ID |
| `ADMIN_EMAIL` | Email used by the server's admin bootstrap configuration |

Never commit `.env` or real credentials to GitHub.

### 3. Run in development

```bash
npm run dev
```

The default local API URL is:

http://localhost:5000

### 4. Build and run in production mode

```bash
npm run build
npm start
```

### 5. Type checking

```bash
npm run typecheck
```

## Stripe Webhook Development

The project includes a Stripe CLI listener script:

```bash
npm run stripe:listen
```

It forwards the configured Stripe events to:

`http://localhost:5000/api/subscriptions/webhook`

Use Stripe test mode and configure the webhook signing secret in the local environment.

## Assignment Challenge Implementation

### 1. Advanced Search and Sorting

The menu API supports query-based menu retrieval, filtering, and sorting. The menu controller and service contain the implementation.

Review:

- `src/modules/menu/menu.controller.ts`
- `src/modules/menu/menu.service.ts`

### 2. JWT / Token Verification

Protected API requests use token verification middleware and role-based authorization.

Review:

- `src/middleware/verifyToken.ts`
- The role authorization middleware

The backend must verify authentication and authorization independently of frontend navigation or role checks.

## Security and Deployment

- Keep MongoDB, Better Auth, Google OAuth, ImgBB, and Stripe credentials in server environment variables.
- Configure the exact production frontend origin in `CLIENT_URL`.
- Configure Better Auth trusted origins and OAuth redirect URLs.
- Configure the Stripe webhook endpoint and signing secret.
- Do not activate Premium based only on the frontend success redirect; rely on verified Stripe webhook events.
- Validate request data and verify resource ownership on protected operations.
- Never expose admin passwords or private API credentials in source control.

## Related Project

PizzaHub frontend:

https://github.com/mdrakibulislammasud/pizzahub-client

Live website:

https://pizzahub-client-zeta.vercel.app/