"use client";

import { createAuthClient } from "better-auth/react";

/** Browser-side auth. Only sign-in and sign-out are used; there is no signup
 *  surface because the server refuses it (see lib/auth.ts). */
export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
