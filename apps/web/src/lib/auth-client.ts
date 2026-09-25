"use client";
import { createAuthClient } from "better-auth/react";

/** Same-origin: better-auth's handler lives at /api/auth on this app. */
export const authClient = createAuthClient();
