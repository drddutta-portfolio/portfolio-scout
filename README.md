# Portfolio Scout

I am building a personal investment analysis application called PortfolioAI.

I have attached four specification files:

PortfolioAI_Master_Blueprint_v1.1_Lovable.md

PortfolioAI_Database_Architecture_Lovable_v1.0.md

PortfolioAI_Development_Rules_v1.0_Lovable.md

PortfolioAI_Lovable_Build_Guide_v1.0.md

Please read all four files completely before proposing any implementation.

Important infrastructure requirements

This PortfolioAI implementation must use:

Lovable for application development

GitHub as the source-code repository and version-control source of truth

Supabase as the database, authentication system and backend platform

Do not use Lovable Cloud as the database/backend.

This is a fresh, independent implementation. Do not assume that any database tables, migrations, functions, RLS policies, frontend components or previous implementation state already exist.

Before making any database or application changes, inspect the actual connected GitHub repository and connected Supabase project.

Your task in this first step

Do not attempt to build the complete application yet.

For now, study the four specification files and prepare a detailed but practical implementation plan for:

Phase 0 — Architecture and Setup

and

Phase 1 — Foundation

Your plan should explain:

The application architecture you propose.

The frontend structure and main React/TypeScript modules.

The Supabase architecture required for Phase 1.

The authentication/login architecture.

The initial database tables, views, functions and RLS policies you expect to create.

The portfolio transaction architecture.

The spreadsheet import workflow:
Upload → Preview → Mapping → Validation → Duplicate/conflict detection → Confirmation → Trusted commit.

How holdings will be derived from transactions.

How brokers, broker accounts, securities, asset classes and portfolio roles will be represented.

How Core, Satellite, Thematic and Watchlist classifications will work.

Which deterministic engines should be implemented in Phase 1 and which should only have architecture/placeholders for later phases.

How Credit Intelligence will be preserved in the architecture even if live credit-rating data integration comes later.

How Position Sizing, Movement Radar and Exit Radar should begin in Phase 1.

The proposed Dashboard, Holdings and Stock Detail page structure.

How provenance and data-quality states will be shown.

What data belongs in Supabase versus external document storage.

How GitHub and Supabase migrations should be managed safely.

The security model, particularly RLS and trusted transaction writes.

Testing and validation required before Phase 1 is considered complete.

The recommended order of implementation.

Important PortfolioAI rules

Please preserve the specifications exactly unless you identify a genuine contradiction.

In particular:

Transactions are the accounting source of truth.

Holdings must be derived from transactions.

Missing data must never silently become zero.

Financial and investment scores must be deterministic.

AI must not invent financial facts or override deterministic calculations.

Core, Satellite and Thematic are different portfolio roles.

Core target is approximately 35 stocks by count, not 35% allocation.

Quality–Growth analysis is diagnostic, not a universal hard gate.

Momentum is mainly a timing/market-behaviour input.

Reduce/Sell is not the same as Exit.

One weak quarter or normal price decline must not automatically trigger demotion or exit.

Credit Intelligence is a required part of the target stock-evaluation architecture.

NOT_RATED or NOT_COVERED must remain neutral, not automatically negative.

Position sizing is separate from stock selection.

Contradictory evidence between Fundamental, Market, External Intelligence and Portfolio engines must remain visible rather than being hidden inside one opaque master score.

The investor remains the final decision-maker.

Database instruction

Do not create migrations or modify Supabase yet.

First provide the plan.

For any proposed database work, show:

tables/views/functions proposed

purpose of each

key relationships

RLS approach

any privileged RPC/Edge Function

migration sequence

security risks

what is intentionally deferred

Output format

Please give me:

Your understanding of PortfolioAI

Architecture summary

Phase 0 implementation plan

Phase 1 implementation plan

Proposed Supabase schema for Phase 1

Proposed frontend/page structure

Security and RLS plan

Import and transaction integrity plan

Deterministic engine plan

What is deferred to later phases

Risks / ambiguities / questions found in the specifications

Recommended first implementation task

Do not implement anything yet. I want to review and approve the plan first.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/922cffe5-3b3e-4a03-b8d1-aca5d38f2e54).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
