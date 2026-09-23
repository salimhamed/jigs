# Recipes

A recipe is a complete workflow that ships with jigs as source code. Adding one
copies its files into your factory, where they become your code: a starting
point to read, run and change. Upgrading jigs never overwrites them.

## Add a recipe

Inside your factory:

```sh
pnpm exec jigs recipe list
pnpm exec jigs recipe add ship
```

`recipe add` reports each file it creates, and keeps any file that already
exists. It does not edit `jigs.config.ts`. Register the workflow yourself by
adding the line it prints to the `workflows` map:

```ts
ship: () => import("./workflows/ship.ts"),
```

Then run `pnpm typecheck`, `pnpm test` and `pnpm exec jigs up`.

## Available recipes

- **ship**: takes a Linear ticket to a merged pull request, with one agent
  implementing and a second reviewing. After `jigs recipe add ship`, read
  `blocks/delivery/README.md` in your factory for what it needs and how to
  change it.
