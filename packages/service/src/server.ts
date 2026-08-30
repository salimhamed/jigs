// The composition root: the only place that names both the app and a factory.
import { createApp } from "./app";
import { demoFactory } from "./demo-factory";

export default createApp(demoFactory);
