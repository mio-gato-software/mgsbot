import {
	activityCurrent,
	timeAwareness,
	weatherCurrent,
} from "./sections/activity.ts";
import { headerDatetime } from "./sections/header.ts";
import { identityPersonality } from "./sections/identity.ts";
import {
	imageAllowedPhotoRequest,
	imageEditUserAttached,
	imageFullAccess,
	imageWeekly,
} from "./sections/image.ts";
import {
	memoryEpisodes,
	memoryGeneralFacts,
	memoryPermanentOther,
	memoryPermanentPersons,
	memoryPersons,
} from "./sections/memory.ts";
import { mentionGroupName } from "./sections/mention.ts";
import { personalityTraits } from "./sections/personality.ts";
import { rulesBehavior, rulesGroup, rulesNewPerson } from "./sections/rules.ts";
import { voiceTts, voiceTutor } from "./sections/voice.ts";
import type { PromptSection } from "./types.ts";

export const PIPELINE: ReadonlyArray<PromptSection> = [
	identityPersonality,
	rulesBehavior,
	rulesGroup,
	rulesNewPerson,
	headerDatetime,
	personalityTraits,
	memoryEpisodes,
	memoryPermanentPersons,
	memoryPermanentOther,
	memoryPersons,
	memoryGeneralFacts,
	activityCurrent,
	timeAwareness,
	weatherCurrent,
	imageWeekly,
	imageEditUserAttached,
	imageAllowedPhotoRequest,
	voiceTts,
	mentionGroupName,
	imageFullAccess,
	voiceTutor,
];
