---
"@chat-adapter/twilio": minor
---

feat(twilio): add RCS support with rich cards, button actions, and location sharing

Extends the Twilio adapter with full RCS support: inbound button tap routing via `processAction`, location share parsing, Content API integration for rich outbound cards with SMS fallback, and channel metadata detection. Cards sent to RCS-capable senders (Messaging Service or `rcs:` address) are automatically rendered as Twilio Content templates with embedded SMS fallback variants.

Existing deployments keep their thread ids: plain SMS threads stay keyed by phone number even when the number belongs to a Messaging Service, and `openDM` still prefers `phoneNumber` over `messagingServiceSid`. Only taps of buttons rendered by Chat SDK become actions; foreign button taps that carry a body keep arriving as messages.
