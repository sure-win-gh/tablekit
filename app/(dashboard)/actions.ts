"use server";

import { redirect } from "next/navigation";

import { clearActiveOrg } from "@/lib/auth/active-org";
import { supabaseServer } from "@/lib/db/supabase-server";

export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  await clearActiveOrg();
  redirect("/login");
}
