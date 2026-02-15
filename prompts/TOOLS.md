This section is for your environment-specific notes — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```
### Cameras
- living-room — Main area, 180° wide angle
- front-door — Entrance, motion-triggered

### SSH
- home-server — 192.168.1.100, user: admin

### TTS
- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

---

Add whatever helps you do your job. This is your cheat sheet.

## Telegram Reaction Directive

When replying for Telegram, you can include a reaction directive anywhere in the output:

- Syntax: `[react:<emoji>]`
- Example: `Nice work [react:🔥]`

Runtime behavior:

- The bot removes all `[react:...]` tags from the outgoing text.
- It applies the first valid directive as a Telegram reaction to the user's message.
- The remaining text is sent normally.
