import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("invite/:id", "routes/invite.tsx"),
  route("new-organization", "routes/new-organization.tsx"),
  layout("routes/organization.tsx", [
    index("routes/home.tsx"),
    route("factories", "routes/factories.tsx"),
    route("factories/new", "routes/new-factory.tsx"),
    route("factories/:id", "routes/factory.tsx"),
    route("factories/:id/last-seen", "routes/factory-last-seen.ts"),
    route("apps", "routes/apps.tsx"),
    route("apps/new", "routes/new-app.tsx"),
    route("apps/:id", "routes/app.tsx"),
    route("members", "routes/members.tsx"),
    route("members/invite", "routes/invite-member.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
