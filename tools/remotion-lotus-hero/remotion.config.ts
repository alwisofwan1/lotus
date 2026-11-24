import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// The scenes are flat colour and type — high CRF would show banding in the one
// gradient (the warm glow), so keep quality generous. The file is hosted, not
// committed, so size is not under the 500 KB asset budget.
Config.setCrf(18);
