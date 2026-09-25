// Remotion bundle entry point: the bundler starts here. Fonts load only inside the bundle.
import { registerRoot } from "remotion";
import "./fonts/load.ts";
import { Root } from "./Root.tsx";

registerRoot(Root);
