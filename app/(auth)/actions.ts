"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type AuthActionState = {
  error?: string;
  info?: string;
};

function parseCredentials(
  formData: FormData,
): { email: string; password: string } | { error: string } {
  const parsed = CredentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  return parsed.data;
}

export async function login(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const credentials = parseCredentials(formData);
  if ("error" in credentials) {
    return { error: credentials.error };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);

  if (error) {
    return { error: error.message };
  }

  redirect("/dashboard");
}

export async function signup(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const credentials = parseCredentials(formData);
  if ("error" in credentials) {
    return { error: credentials.error };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp(credentials);

  if (error) {
    return { error: error.message };
  }

  // With email confirmation enabled on the Supabase project, signUp
  // succeeds but returns no session until the user clicks the confirmation
  // link - that's a real, different outcome from an immediately-active
  // account, not an error, so it gets its own message rather than being
  // treated as a login.
  if (data.session) {
    redirect("/dashboard");
  }

  return { info: "Check your email to confirm your account, then sign in." };
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
