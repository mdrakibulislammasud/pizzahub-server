
import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

import { client } from "./db.js";
import { env } from "./env.js";

const googleConfigured =
  Boolean(env.GOOGLE_CLIENT_ID) &&
  Boolean(env.GOOGLE_CLIENT_SECRET);

export const auth = betterAuth({
  database: mongodbAdapter(client.db(env.DB_NAME), { client }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.CLIENT_URL],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
  },

  ...(googleConfigured && {
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      },
    },
  }),

  user: {
    additionalFields: {
      role: {
        type: ["customer", "vendor", "admin"],
        required: false,
        defaultValue: "customer",
        input: true,
      },

      isBlocked: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },

      businessName: {
        type: "string",
        required: false,
        input: true,
      },

      subscriptionPlan: {
        type: ["free", "premium"],
        required: false,
        defaultValue: "free",
        input: false,
      },

      subscriptionExpiresAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") {
        if (
          ctx.body &&
          ("role" in ctx.body ||
            "isBlocked" in ctx.body ||
            "subscriptionPlan" in ctx.body ||
            "subscriptionExpiresAt" in ctx.body)
        ) {
          throw new APIError("FORBIDDEN", {
            message: "You cannot modify protected account fields.",
          });
        }

        return;
      }

      const password = ctx.body?.password;
      const role = ctx.body?.role;
      const businessName = ctx.body?.businessName;

      if (
        typeof password !== "string" ||
        password.length < 6 ||
        !/[A-Z]/.test(password) ||
        !/[a-z]/.test(password)
      ) {
        throw new APIError("BAD_REQUEST", {
          message:
            "Password must contain at least 6 characters, including uppercase and lowercase letters.",
        });
      }

      if (
        role !== undefined &&
        role !== "customer" &&
        role !== "vendor"
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "Invalid account role. Choose Customer or Vendor.",
        });
      }

      if (
        role === "vendor" &&
        (typeof businessName !== "string" || !businessName.trim())
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "Restaurant business name is required for vendors.",
        });
      }

      if (
        role === "customer" &&
        businessName !== undefined &&
        businessName !== ""
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "Business name is only allowed for vendor accounts.",
        });
      }
    }),
  },

  plugins: [
    jwt({
      jwt: {
        definePayload: ({ user }) => ({
          id: user.id,
          email: user.email,
          role: user.role,
          isBlocked: user.isBlocked,
        }),
      },
    }),
  ],

  advanced: {
    database: {
      generateId: "uuid",
    },
  },
});

