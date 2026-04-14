# Solana Telegram Bot — Nigeria Utility Payments

A grammY-powered Telegram bot that lets users pay Nigerian utility bills (airtime, data) using USDC on Solana. Built for the Nigerian market.

---

## Stack

| Layer | Technology |
|---|---|
| Bot framework | grammY + @grammyjs/conversations |
| Database | Supabase (Postgres) |
| Blockchain | @solana/web3.js + @solana/spl-token |
| AI parsing | OpenAI GPT-4o-mini (function calling) |
| Payout | paj_ramp |
| Security | AES-256-GCM (private keys) + bcrypt (PIN) |

---

## Project Structure

```
src/
├── index.ts                   # Bot entry point
├── types/
│   ├── index.ts               # All TypeScript types
│   └── context.ts             # grammY context + session types
├── services/
│   ├── ai.ts                  # OpenAI intent parsing
│   ├── pajRamp.ts             # paj_ramp integration (isolated)
│   ├── price.ts               # NGN/USDC oracle + quotes
│   ├── solana.ts              # USDC transfers on Solana
│   ├── supabase.ts            # Supabase client
│   ├── transactions.ts        # Transaction DB logging
│   └── wallet.ts              # Wallet creation, PIN, decryption
├── handlers/
│   ├── commands.ts            # /balance /wallet /history /help /changepin
│   ├── purchase.ts            # Main buy flow conversation
│   └── start.ts               # /start + PIN setup conversation
└── utils/
    ├── crypto.ts              # AES-256-GCM encrypt/decrypt
    └── helpers.ts             # Phone normalisation, formatting

supabase/
└── schema.sql                 # Run this in Supabase SQL Editor
```

---

## Transaction Flow

```
User types message
       ↓
  AI parses intent → structured JSON
       ↓
  Price oracle fetches NGN/USDC rate
       ↓
  Bot shows summary + Confirm/Cancel keyboard
       ↓
  User taps Confirm
       ↓
  Bot asks for 4-digit PIN (message deleted immediately)
       ↓
  bcrypt compare → 3 attempts max, then 15 min lockout
       ↓
  USDC transferred from wallet → treasury (Solana)
       ↓
  Await Solana confirmation (~400ms)
       ↓
  paj_ramp.airtime() or paj_ramp.data() triggered
       ↓
  Receipt sent to user
```

**Rule:** paj_ramp is NEVER called before a confirmed Solana signature.

---

## Security Notes

- Private keys are AES-256-GCM encrypted at rest; only decrypted for the duration of a signing call
- PINs are bcrypt-hashed (12 rounds) — never stored in plaintext
- PIN messages are deleted from Telegram immediately after receipt
- 3 failed PIN attempts triggers a 15-minute lockout
- The service_role Supabase key is only used server-side, never exposed to users
- All paj_ramp calls carry a unique cryptographic reference for idempotency


