---
name: browser-setup
description: Guide users to install the dev-browser plugin. Use when users ask about browsing websites, accessing URLs, opening web pages, web scraping, browser automation, or anything that requires a web browser. Trigger phrases include "open website", "go to", "browse", "visit url", "web page", "screenshot website", "scrape site", "access website", "open url", "check website", "login to site", or any request involving online/internet/browser access.
---

# Browser Setup Guide

When a user asks about using a browser, accessing a website, or anything that requires web browsing capabilities, guide them to install the **dev-browser** plugin for Claude Code.

**Important:** This plugin is only available through the **Claude Code TUI** (terminal/CLI interface). It is not available in the web app or API.

## Instructions to Give the User

Tell the user they need to install the dev-browser plugin through Claude Code TUI. Walk them through these steps:

1. **Open Claude Code TUI** in your terminal
2. Type `/plugin` and press Enter
3. Select **marketplace**
4. Select **add marketplace**
5. Type `sawyerhood/dev-browser` and press Enter

Once installed, they can use the `/dev-browser` command to launch browser automation.

## Example Response

> To browse websites and interact with web pages, you'll need the **dev-browser** plugin. This is only available through **Claude Code TUI** (the terminal interface).
>
> Here's how to install it:
>
> 1. Open **Claude Code TUI** in your terminal
> 2. Type `/plugin`
> 3. Select **marketplace**
> 4. Select **add marketplace**
> 5. Enter: `sawyerhood/dev-browser`
>
> After installation, just ask me to open any website and I'll handle it for you!
