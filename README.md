
# Gym Management System Backend

Backend for a gym management system built with Node.js, Express.js, MongoDB, Mongoose, JWT authentication, and email notifications.

## Features

- User registration and login
- JWT authentication and role-based admin authorization
- Forgot password and reset password via email link
- Subscription creation and membership plan management
- Payment submission and manual admin approval flow
- Email notifications for welcome, password reset, subscription confirmation, and payment status

## Project Structure

- `src/config/` - DB, mailer, and cloudinary configuration
- `src/controllers/` - request handlers
- `src/middleware/` - auth, admin, upload, and error handling
- `src/models/` - Mongoose schemas
- `src/routes/` - API routes
- `src/services/` - business logic and email helpers
- `src/utils/` - token generation and standardized response helpers

## Installation

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and set your values.

3. Start the server:

```bash
npm run dev
```

## API Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password/:token`
- `GET /api/users/profile`
- `PUT /api/users/profile`
- `GET /api/users/subscriptions`
- `GET /api/users/payments`
- `GET /api/subscriptions/plans`
- `POST /api/subscriptions/create`
- `GET /api/subscriptions/my-subscription`
- `POST /api/payments/submit`
- `GET /api/payments/history`
- `GET /api/admin/users`
- `GET /api/admin/payments`
- `PUT /api/admin/payments/:id/approve`
- `PUT /api/admin/payments/:id/reject`
- `GET /api/admin/subscriptions`
- `POST /api/admin/plans`
- `PUT /api/admin/plans/:id`
- `DELETE /api/admin/plans/:id`
