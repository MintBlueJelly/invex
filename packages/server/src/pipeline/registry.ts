import type { StageRegistry } from "./machine";
import { imageLaneStage } from "./stages/imageLane";
import { reconcileStage } from "./stages/reconcile";
import { routeStage } from "./stages/route";
import { textLaneStage } from "./stages/textLane";
import { vlmEscalateStage } from "./stages/vlmEscalate";
import { zugferdStage } from "./stages/zugferd";

export function buildRegistry(): StageRegistry {
  return {
    statuses: {
      received: routeStage,
      extracted: reconcileStage,
      escalated_vlm: vlmEscalateStage,
    },
    lanes: {
      zugferd: zugferdStage,
      text: textLaneStage,
      image: imageLaneStage,
    },
  };
}
