# Contributing

Never commit session files, tokens, HAR captures, real transactions, merchants, amounts, or account or card numbers. Tests use made-up ids and recorded shapes only.

```sh
npm install
npm run check
```

Every call that changes the account must be one RiseUp's own web app makes for the same action, with the same body. Nothing that touches bank or card connections, payments or the subscription.
