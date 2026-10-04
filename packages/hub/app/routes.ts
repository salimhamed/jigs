import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("invite/:id", "routes/invite.tsx"),
  route("new-organization", "routes/new-organization.tsx"),
  layout("routes/organization.tsx", [
    index("routes/home.tsx"),
    route("factories", "routes/factories.tsx"),
    route("factories/:id", "routes/factory.tsx"),
    route("apps", "routes/apps.tsx"),
    route("apps/:id", "routes/app.tsx"),
    route("members", "routes/members.tsx"),
    route("invites", "routes/invites.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
