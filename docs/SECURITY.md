# Security Notes

No production secret is stored in this repository. Admin bootstrap, session signing, OTP hashing and Zalo credentials are Worker secrets/environment values. Development CTV auth and development OTP are explicit environment-gated features and must not be silently enabled in public production.
