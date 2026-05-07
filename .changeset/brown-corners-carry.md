---
"shellular": patch
---

fix: pagination in opencode sdk causes infinite loop, fixed

the problem was opencode SDK, so i removed pagination logic in opencode.

if you set start to even 999 in opencode it still returns values, so basically it keeps on returning values
