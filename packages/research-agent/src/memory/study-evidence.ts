// SPDX-License-Identifier: Apache-2.0

export type MemoryStudyStatus = "not_started" | "ongoing" | "complete";

export interface MemoryStudyEvidenceV1 {
	format: "doro-memory-study-evidence";
	version: 1;
	status: MemoryStudyStatus;
	governance: {
		candidateCommit: string;
		ethicsDecision: "approved" | "exempt";
		ethicsDecisionRef: string;
		protocolRef: string;
		consentFormRef: string;
		randomizationPlanRef: string;
		exitProcedureRef: string;
		dataControllerRef: string;
	};
	startedAt: string;
	completedAt: string | null;
	participants: Array<{
		participantRef: string;
		consentReceiptRef: string;
		disposition: "active" | "completed" | "withdrawn";
		memoryDeletionRequested: boolean;
		memoryDeletionVerified: boolean;
	}>;
	tasks: Array<{
		participantRef: string;
		taskRef: string;
		sessionRef: string;
		projectRef: string;
		pairRef: string;
		reviewerRef: string;
		observedAt: string;
		condition: "memory_on" | "memory_off";
		sequence: 1 | 2;
		eligible: boolean;
		restrictedProject: boolean;
		correctionRef: string | null;
		blindWinner: "memory" | "baseline" | "tie" | "not_scored";
	}>;
}

export interface MemoryStudyEvidenceReportV1 {
	format: "doro-memory-study-evidence-report";
	version: 1;
	status: MemoryStudyStatus;
	candidateCommit: string;
	counts: {
		enrolledParticipants: number;
		completedParticipants: number;
		tasks: number;
	};
	minimumsPerCompletedParticipant: {
		distinctWeeks: number;
		distinctSessions: number;
		distinctProjects: number;
		distinctRestrictedProjects: number;
		distinctCorrectionRefs: number;
		eligibleTasks: number;
	};
	balancedFirstConditionPerParticipant: boolean;
	eligiblePairBlindScoringCoverage: number | null;
	betaPilotStarted: boolean;
	stableStudyEligible: boolean;
}

const dayMilliseconds = 86_400_000;
const weekMilliseconds = 7 * dayMilliseconds;
const commitPattern = /^[a-f0-9]{40}$/u;
const sha256RefPattern = /^sha256:[a-f0-9]{64}$/u;
const hmacRefPattern = /^hmac-sha256:[a-f0-9]{64}$/u;
const rootKeys = new Set([
	"format",
	"version",
	"status",
	"governance",
	"startedAt",
	"completedAt",
	"participants",
	"tasks",
]);
const governanceKeys = new Set([
	"candidateCommit",
	"ethicsDecision",
	"ethicsDecisionRef",
	"protocolRef",
	"consentFormRef",
	"randomizationPlanRef",
	"exitProcedureRef",
	"dataControllerRef",
]);
const participantKeys = new Set([
	"participantRef",
	"consentReceiptRef",
	"disposition",
	"memoryDeletionRequested",
	"memoryDeletionVerified",
]);
const taskKeys = new Set([
	"participantRef",
	"taskRef",
	"sessionRef",
	"projectRef",
	"pairRef",
	"reviewerRef",
	"observedAt",
	"condition",
	"sequence",
	"eligible",
	"restrictedProject",
	"correctionRef",
	"blindWinner",
]);

function object(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
	const actual = Object.keys(value);
	const unexpected = actual.filter((key) => !expected.has(key));
	const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
	if (unexpected.length > 0 || missing.length > 0) {
		throw new TypeError(`${label} keys are invalid`);
	}
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
	return value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
	return value;
}

function timestamp(value: unknown, label: string): { value: string; milliseconds: number } {
	if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp`);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
		throw new TypeError(`${label} must be a canonical ISO timestamp`);
	}
	return { value, milliseconds };
}

function minimum(values: readonly number[]): number {
	return values.length === 0 ? 0 : Math.min(...values);
}

export function evaluateMemoryStudyEvidence(input: unknown): MemoryStudyEvidenceReportV1 {
	const now = Date.now();
	const root = object(input, "study evidence");
	exactKeys(root, rootKeys, "study evidence");
	if (root.format !== "doro-memory-study-evidence" || root.version !== 1) {
		throw new TypeError("study evidence format/version is invalid");
	}
	if (root.status !== "not_started" && root.status !== "ongoing" && root.status !== "complete") {
		throw new TypeError("study evidence status is invalid");
	}

	const governance = object(root.governance, "governance");
	exactKeys(governance, governanceKeys, "governance");
	const candidateCommit = matchingString(governance.candidateCommit, commitPattern, "governance.candidateCommit");
	if (governance.ethicsDecision !== "approved" && governance.ethicsDecision !== "exempt") {
		throw new TypeError("governance.ethicsDecision is invalid");
	}
	for (const key of [
		"ethicsDecisionRef",
		"protocolRef",
		"consentFormRef",
		"randomizationPlanRef",
		"exitProcedureRef",
	] as const) {
		matchingString(governance[key], sha256RefPattern, `governance.${key}`);
	}
	matchingString(governance.dataControllerRef, hmacRefPattern, "governance.dataControllerRef");

	const startedAt = timestamp(root.startedAt, "startedAt");
	const completedAt = root.completedAt === null ? null : timestamp(root.completedAt, "completedAt");
	if (root.status === "complete" ? completedAt === null : completedAt !== null) {
		throw new TypeError("completedAt must be present only when status is complete");
	}
	if (completedAt !== null && completedAt.milliseconds < startedAt.milliseconds) {
		throw new TypeError("completedAt precedes startedAt");
	}
	if (
		root.status !== "not_started" &&
		(startedAt.milliseconds > now || (completedAt !== null && completedAt.milliseconds > now))
	) {
		throw new TypeError("study timestamps cannot be in the future");
	}
	if (!Array.isArray(root.participants) || !Array.isArray(root.tasks)) {
		throw new TypeError("participants and tasks must be arrays");
	}

	const participantRefs = new Set<string>();
	const consentReceiptRefs = new Set<string>();
	const participants = root.participants.map((value, index): MemoryStudyEvidenceV1["participants"][number] => {
		const participant = object(value, `participant ${index}`);
		exactKeys(participant, participantKeys, `participant ${index}`);
		const participantRef = matchingString(
			participant.participantRef,
			hmacRefPattern,
			`participant ${index} participantRef`,
		);
		if (participantRefs.has(participantRef)) throw new TypeError(`participant ${index} duplicates participantRef`);
		participantRefs.add(participantRef);
		if (
			participant.disposition !== "active" &&
			participant.disposition !== "completed" &&
			participant.disposition !== "withdrawn"
		) {
			throw new TypeError(`participant ${index} disposition is invalid`);
		}
		const memoryDeletionRequested = boolean(
			participant.memoryDeletionRequested,
			`participant ${index} memoryDeletionRequested`,
		);
		const memoryDeletionVerified = boolean(
			participant.memoryDeletionVerified,
			`participant ${index} memoryDeletionVerified`,
		);
		if (memoryDeletionRequested !== memoryDeletionVerified) {
			throw new TypeError(`participant ${index} Personal Memory deletion is not consistently verified`);
		}
		const consentReceiptRef = matchingString(
			participant.consentReceiptRef,
			hmacRefPattern,
			`participant ${index} consentReceiptRef`,
		);
		if (consentReceiptRefs.has(consentReceiptRef)) {
			throw new TypeError(`participant ${index} duplicates consentReceiptRef`);
		}
		consentReceiptRefs.add(consentReceiptRef);
		return {
			participantRef,
			consentReceiptRef,
			disposition: participant.disposition,
			memoryDeletionRequested,
			memoryDeletionVerified,
		};
	});
	if (root.status === "not_started" && (participants.length > 0 || root.tasks.length > 0)) {
		throw new TypeError("not_started study evidence cannot contain participants or tasks");
	}
	if (root.status === "complete" && participants.some(({ disposition }) => disposition === "active")) {
		throw new TypeError("complete study evidence cannot contain active participants");
	}

	const taskRefs = new Set<string>();
	const projectRestrictions = new Map<string, boolean>();
	const tasks = root.tasks.map((value, index): MemoryStudyEvidenceV1["tasks"][number] => {
		const task = object(value, `task ${index}`);
		exactKeys(task, taskKeys, `task ${index}`);
		const participantRef = matchingString(task.participantRef, hmacRefPattern, `task ${index} participantRef`);
		if (!participantRefs.has(participantRef)) throw new TypeError(`task ${index} participant does not exist`);
		const taskRef = matchingString(task.taskRef, hmacRefPattern, `task ${index} taskRef`);
		if (taskRefs.has(taskRef)) throw new TypeError(`task ${index} duplicates taskRef`);
		taskRefs.add(taskRef);
		const reviewerRef = matchingString(task.reviewerRef, hmacRefPattern, `task ${index} reviewerRef`);
		if (participantRefs.has(reviewerRef)) {
			throw new TypeError(`task ${index} reviewer must be independent of study participants`);
		}
		const observedAt = timestamp(task.observedAt, `task ${index} observedAt`);
		if (
			observedAt.milliseconds < startedAt.milliseconds ||
			(completedAt !== null && observedAt.milliseconds > completedAt.milliseconds) ||
			(root.status !== "not_started" && observedAt.milliseconds > now)
		) {
			throw new TypeError(`task ${index} observedAt is outside the study window`);
		}
		if (task.condition !== "memory_on" && task.condition !== "memory_off") {
			throw new TypeError(`task ${index} condition is invalid`);
		}
		if (task.sequence !== 1 && task.sequence !== 2) throw new TypeError(`task ${index} sequence is invalid`);
		if (
			task.blindWinner !== "memory" &&
			task.blindWinner !== "baseline" &&
			task.blindWinner !== "tie" &&
			task.blindWinner !== "not_scored"
		) {
			throw new TypeError(`task ${index} blindWinner is invalid`);
		}
		const projectRef = matchingString(task.projectRef, hmacRefPattern, `task ${index} projectRef`);
		const restrictedProject = boolean(task.restrictedProject, `task ${index} restrictedProject`);
		const knownRestriction = projectRestrictions.get(projectRef);
		if (knownRestriction !== undefined && knownRestriction !== restrictedProject) {
			throw new TypeError(`task ${index} project restricted marker is inconsistent`);
		}
		projectRestrictions.set(projectRef, restrictedProject);
		return {
			participantRef,
			taskRef,
			sessionRef: matchingString(task.sessionRef, hmacRefPattern, `task ${index} sessionRef`),
			projectRef,
			pairRef: matchingString(task.pairRef, hmacRefPattern, `task ${index} pairRef`),
			reviewerRef,
			observedAt: observedAt.value,
			condition: task.condition,
			sequence: task.sequence,
			eligible: boolean(task.eligible, `task ${index} eligible`),
			restrictedProject,
			correctionRef:
				task.correctionRef === null
					? null
					: matchingString(task.correctionRef, hmacRefPattern, `task ${index} correctionRef`),
			blindWinner: task.blindWinner,
		};
	});

	const pairs = new Map<string, MemoryStudyEvidenceV1["tasks"]>();
	for (const task of tasks) {
		const pair = pairs.get(task.pairRef) ?? [];
		pair.push(task);
		pairs.set(task.pairRef, pair);
	}
	const firstConditions = new Map<string, { on: number; off: number }>();
	for (const pair of pairs.values()) {
		if (pair.length !== 2) throw new TypeError("each pair must contain exactly two tasks");
		const first = pair[0] as MemoryStudyEvidenceV1["tasks"][number];
		const second = pair[1] as MemoryStudyEvidenceV1["tasks"][number];
		if (
			first.participantRef !== second.participantRef ||
			first.reviewerRef !== second.reviewerRef ||
			first.blindWinner !== second.blindWinner ||
			first.eligible !== second.eligible
		) {
			throw new TypeError("paired tasks have inconsistent fields");
		}
		if (
			new Set(pair.map(({ sequence }) => sequence)).size !== 2 ||
			new Set(pair.map(({ condition }) => condition)).size !== 2
		) {
			throw new TypeError("paired tasks must contain sequences 1/2 and memory on/off");
		}
		const firstTask = pair.find(({ sequence }) => sequence === 1) as MemoryStudyEvidenceV1["tasks"][number];
		const secondTask = pair.find(({ sequence }) => sequence === 2) as MemoryStudyEvidenceV1["tasks"][number];
		if (Date.parse(firstTask.observedAt) > Date.parse(secondTask.observedAt)) {
			throw new TypeError("paired task timestamps are reversed");
		}
		const counts = firstConditions.get(first.participantRef) ?? { on: 0, off: 0 };
		counts[firstTask.condition === "memory_on" ? "on" : "off"] += 1;
		firstConditions.set(first.participantRef, counts);
	}
	const balancedFirstConditionPerParticipant = participants.every(({ participantRef }) => {
		const counts = firstConditions.get(participantRef) ?? { on: 0, off: 0 };
		return Math.abs(counts.on - counts.off) <= 1;
	});

	const completedParticipants = participants.filter(({ disposition }) => disposition === "completed");
	const completedMeasures = completedParticipants.map(({ participantRef }) => {
		const participantTasks = tasks.filter(
			(task) =>
				task.participantRef === participantRef &&
				Date.parse(task.observedAt) - startedAt.milliseconds < 84 * dayMilliseconds,
		);
		const weeks = new Set(
			participantTasks.map(({ observedAt }) =>
				Math.floor((Date.parse(observedAt) - startedAt.milliseconds) / weekMilliseconds),
			),
		);
		return {
			weeks: weeks.size,
			weeksComplete: Array.from({ length: 12 }, (_, week) => weeks.has(week)).every(Boolean),
			sessions: new Set(participantTasks.map(({ sessionRef }) => sessionRef)).size,
			projects: new Set(participantTasks.map(({ projectRef }) => projectRef)).size,
			restrictedProjects: new Set(
				participantTasks.filter(({ restrictedProject }) => restrictedProject).map(({ projectRef }) => projectRef),
			).size,
			corrections: new Set(
				participantTasks.flatMap(({ correctionRef }) => (correctionRef === null ? [] : [correctionRef])),
			).size,
			eligibleTasks: participantTasks.filter(({ eligible }) => eligible).length,
		};
	});
	const eligiblePairs = [...pairs.values()].filter(([task]) => task?.eligible === true);
	const eligiblePairBlindScoringCoverage =
		eligiblePairs.length === 0
			? null
			: Number(
					(
						eligiblePairs.filter(([task]) => task?.blindWinner !== "not_scored").length / eligiblePairs.length
					).toFixed(6),
				);
	const minimumsPerCompletedParticipant = {
		distinctWeeks: minimum(completedMeasures.map(({ weeks }) => weeks)),
		distinctSessions: minimum(completedMeasures.map(({ sessions }) => sessions)),
		distinctProjects: minimum(completedMeasures.map(({ projects }) => projects)),
		distinctRestrictedProjects: minimum(completedMeasures.map(({ restrictedProjects }) => restrictedProjects)),
		distinctCorrectionRefs: minimum(completedMeasures.map(({ corrections }) => corrections)),
		eligibleTasks: minimum(completedMeasures.map(({ eligibleTasks }) => eligibleTasks)),
	};
	const eligiblePairParticipants = new Set(
		eligiblePairs.flatMap(([task]) => (task === undefined ? [] : [task.participantRef])),
	);
	const betaPilotParticipantCount = participants.filter(
		({ participantRef, disposition }) => disposition !== "withdrawn" && eligiblePairParticipants.has(participantRef),
	).length;
	const stableStudyEligible =
		root.status === "complete" &&
		completedAt !== null &&
		completedAt.milliseconds - startedAt.milliseconds >= 84 * dayMilliseconds &&
		completedParticipants.length >= 30 &&
		completedMeasures.every(({ weeksComplete }) => weeksComplete) &&
		minimumsPerCompletedParticipant.distinctSessions >= 24 &&
		minimumsPerCompletedParticipant.distinctProjects >= 3 &&
		minimumsPerCompletedParticipant.distinctRestrictedProjects >= 1 &&
		minimumsPerCompletedParticipant.distinctCorrectionRefs >= 2 &&
		minimumsPerCompletedParticipant.eligibleTasks >= 40 &&
		balancedFirstConditionPerParticipant &&
		eligiblePairBlindScoringCoverage === 1;

	return {
		format: "doro-memory-study-evidence-report",
		version: 1,
		status: root.status,
		candidateCommit,
		counts: {
			enrolledParticipants: participants.length,
			completedParticipants: completedParticipants.length,
			tasks: tasks.length,
		},
		minimumsPerCompletedParticipant,
		balancedFirstConditionPerParticipant,
		eligiblePairBlindScoringCoverage,
		betaPilotStarted: root.status !== "not_started" && betaPilotParticipantCount >= 10,
		stableStudyEligible,
	};
}
