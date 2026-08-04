import { z } from "zod";

// Trims and uppercases before validating, so "aapl" and " tsla " are normal
// user input, not errors - only content that isn't 1-5 letters is rejected.
export const SymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,5}$/, "Symbol must be 1-5 letters (A-Z), no digits or other characters");
