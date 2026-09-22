# CUNNACT — UI/UX Blueprint

Design direction is based on the principles provided for this project: sleek dark/light surfaces, typography-led hierarchy, balanced 8pt spacing, restrained visual noise, clear active states, purposeful micro-interactions, and high-performance interactions.

## 1. Design system

### Color tokens

Light mode
- Background: `#F4F5F7`
- Surface: `#FFFFFF`
- Secondary surface: `#F8F9FB`
- Tertiary surface: `#F0F2F5`
- Border: `#E3E6EB`
- Text: `#11131A`
- Secondary text: `#626A79`
- Muted text: `#9098A7`
- Primary accent: `#5B57E6`
- Accent soft: `#EEEDFF`
- Online: `#21C56B`
- Danger: `#DC4F52`

Dark mode
- Background: `#0B0D11`
- Surface: `#111419`
- Secondary surface: `#171A20`
- Tertiary surface: `#1C2027`
- Border: `rgba(255,255,255,.09)`
- Text: `#F5F7FB`
- Secondary text: `#AAB2C2`
- Muted text: `#7E8798`
- Primary accent: `#8B88FF`

### Typography
- Family: Inter, system sans-serif fallback.
- H1: 27–30px / 1.15 / 800 / negative tracking.
- H2: 20–22px / 1.2 / 700.
- Chat name: 13–14px / 1.3 / 700.
- Body message: 13–14px / 1.5 / 400–500.
- Secondary UI: 10–12px / 1.4 / 600.
- Micro labels: 9–10px / 1 / 800 / uppercase / 0.12–0.14em letter spacing.

### Spacing
Use an 8pt base system:
`4, 8, 12, 16, 20, 24, 32, 40, 48, 64`.

### Shape and elevation
- Small controls: 10–12px radius.
- Inputs/cards: 13–22px radius.
- Primary surfaces use borders before shadows.
- Shadows stay soft and directional; avoid heavy floating panels.
- Glass effects are reserved for headers/composers and use blur only where it improves layering.

## 2. Main application architecture

Current production layout uses two functional columns:
1. Conversation workspace/sidebar.
2. Active chat surface.

A contextual third-panel architecture can be introduced later without changing the core chat contract.

### Sidebar
- Brand header with compact logo lockup.
- Account actions in the three-dot account menu.
- Current-user identity card.
- Existing-chat search only.
- Primary `+ New chat` CTA.
- Conversation list with avatar, last message preview, time, unread badge and blocked state.
- Requests and Saved Messages utility cards.

### Chat surface
- Sticky chat header with avatar, online/last-seen state, and three-dot conversation actions.
- Feed is visually quiet; bubbles carry the emphasis.
- Sent messages use the accent gradient; received messages use elevated surfaces.
- Action menu appears on hover/focus and supports save, delete-for-me and delete-for-everyone where applicable.
- Composer remains visually anchored at the bottom.

## 3. Mobile behavior

- Under 820px, sidebar becomes the primary screen and active chat becomes a full-screen surface.
- Back control is always available from active chat.
- Touch targets stay around 40–44px minimum.
- Modals become near-full-height sheets with 90vh max height.
- Message action affordances remain reachable without requiring precise hover behavior.

## 4. Micro-interactions

- Buttons use a subtle lift on hover and scale-down on press.
- Message entry uses a short 200ms slide/fade.
- Search results animate in with a short vertical fade.
- Toasts slide in from the bottom and never block the composer for long.
- Message deletion uses a short collapse animation.
- Respect `prefers-reduced-motion` and disable non-essential animation when requested by the OS.

## 5. Interaction rules

- Account actions remain inside the account three-dot menu.
- New people are found through `+ New chat`; the main sidebar search never performs global user discovery.
- The global new-chat search requires at least six characters and uses email prefix matching.
- Confirmation dialogs are custom CUNNACT modal components, not browser `alert()` / `confirm()` UI.
- Blocked conversations visibly disable the composer and communicate the state in the chat surface.

## 6. Performance rules

- Keep DOM depth shallow in frequently rerendered message rows.
- Use CSS transitions instead of JavaScript animation loops.
- Avoid expensive shadows/blur on every message bubble.
- Keep real-time listeners scoped to the signed-in user's conversations and active chat.
- Never put secrets in client code.

## Navigation deduplication
The desktop rail is intentionally minimal (Chats + theme), while Requests and Saved Messages live in the main sidebar and New Chat lives beside Conversations. This avoids duplicated controls while retaining mobile accessibility.
