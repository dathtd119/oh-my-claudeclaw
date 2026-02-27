Classify the following Telegram message into exactly one category.

## Categories

**secretary** — PostSale work messages:
- WhatsApp alerts forwarded from customers or partners
- Network incidents, outages, performance issues
- Customer issues: MINEDU, COAR, PRONATEL, B2B enterprise clients
- Partner communications (vendors, integrators)
- Department coordination: NOC, PMO, SMO, KAM, Presale, TRA, IP, Infrastructure
- Project updates, ticket statuses, escalations
- Anything work-related to Bitel/Viettel Peru PostSale operations

**general** — Everything else:
- Personal requests, casual chat
- General questions, research, news
- System admin tasks, coding, tools
- Reminders unrelated to work
- Digest confirmations, non-work notifications

## Output

Respond with JSON only, no other text:
{"category": "secretary"|"general", "reason": "brief reason"}

## Message to classify

{{MESSAGE}}
