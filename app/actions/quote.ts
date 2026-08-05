"use server";

import { fetchQuote } from "@/lib/market/alpaca";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SymbolSchema } from "@/lib/trading/symbol";

export type QuoteLookupResult =
  { ok: true; bidCents: string; askCents: string; timestampMs: number } | { ok: false };

// A Server Action is a public endpoint regardless of which page calls it,
// so this still checks auth even though the quote itself isn't user-specific
// data - otherwise it's an open, unauthenticated proxy onto the Alpaca API
// paid for by this app's own credentials.
//
// bidCents/askCents cross back to the client as strings, not bigint - kept
// symmetric with how the dashboard passes cash to OrderTicket (see the note
// there) rather than relying on RSC's bigint support for one payload but
// not the other.
export async function getQuoteForSymbol(rawSymbol: string): Promise<QuoteLookupResult> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false };
  }

  const parsed = SymbolSchema.safeParse(rawSymbol);
  if (!parsed.success) {
    return { ok: false };
  }

  try {
    const quote = await fetchQuote(parsed.data);
    return {
      ok: true,
      bidCents: quote.bidCents.toString(),
      askCents: quote.askCents.toString(),
      timestampMs: quote.timestamp.getTime(),
    };
  } catch {
    return { ok: false };
  }
}
