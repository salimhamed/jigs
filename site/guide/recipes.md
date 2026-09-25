# Recipes

A recipe is a complete workflow that ships with jigs as source code. Adding one
copies its files into your factory, where they become your code: a starting
point to read, run and change. Upgrading jigs never overwrites them.

## Add a recipe

Inside your factory:

```sh
pnpm exec jigs recipe list
pnpm exec jigs recipe add linear-ticket-to-pr
```

`recipe add` reports each file it creates, and keeps any file that already
exists. It registers the workflow by adding this line to the `workflows` map in
`jigs.config.ts`:

```ts
"linear-ticket-to-pr": () => import("./workflows/linear-ticket-to-pr.ts"),
```

Then run `pnpm exec jigs up`.

## Available recipes

- **linear-ticket-to-pr**: takes a Linear ticket to a merged pull request, with
  one agent implementing and a second reviewing. After
  `jigs recipe add linear-ticket-to-pr`, read `workflows/linear-ticket-to-pr/delivery/README.md` in
  your factory for what it needs and how to change it.
