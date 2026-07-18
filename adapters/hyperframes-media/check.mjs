import { locateMediaUseSkill } from "./mediaUse.mjs";

const skill = locateMediaUseSkill();
if (!skill) {
  console.error("HyperFrames media-use is missing. Run `npx --no-install hyperframes skills update media-use`.");
  process.exit(30);
}

console.log(`hyperframes media-use ready: ${skill.root}`);
