# Architecture

MẫuMới is a Cloudflare-native application. One Worker serves `/api/*` and a responsive browser SPA. D1 stores transactional data; R2 stores private evidence images. Authentication uses opaque session cookies stored as hashes in D1. OTP logic is provider-based so development and Zalo ZBS integrations share the same business rules. Inventory is derived from immutable allocation, adjustment and distribution transactions.
