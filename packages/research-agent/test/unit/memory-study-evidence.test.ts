// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { evaluateMemoryStudyEvidence, type MemoryStudyEvidenceV1 } from "../../src/memory/study-evidence.ts";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const releaseBlockerCodes = [
	"STUDY_EVIDENCE_V1_NOT_RELEASE_QUALIFYING",
	"CANDIDATE_COMMIT_UNBOUND",
	"EXACT_RECEIPTS_UNBOUND",
	"FIELD_JUDGMENTS_UNBOUND",
	"QUALITY_GATES_UNBOUND",
	"CONFIGURATION_HASHES_UNBOUND",
];

function hmac(value: number): string {
	return `hmac-sha256:${value.toString(16).padStart(64, "0")}`;
}

function sha(value: string): string {
	return `sha256:${value.repeat(64)}`;
}

function observed(day: number): string {
	return new Date(start + day * 86_400_000).toISOString();
}

function evidence(participantCount: number, status: "ongoing" | "complete"): MemoryStudyEvidenceV1 {
	let nextRef = 1;
	const participants: MemoryStudyEvidenceV1["participants"] = [];
	const tasks: MemoryStudyEvidenceV1["tasks"] = [];
	for (let participantIndex = 0; participantIndex < participantCount; participantIndex += 1) {
		const participantRef = hmac(nextRef++);
		participants.push({
			participantRef,
			consentReceiptRef: hmac(nextRef++),
			disposition: status === "complete" ? "completed" : "active",
			memoryDeletionRequested: false,
			memoryDeletionVerified: false,
		});
		const pairCount = status === "complete" ? 20 : 1;
		const projects = [hmac(nextRef++), hmac(nextRef++), hmac(nextRef++)];
		const corrections = [hmac(nextRef++), hmac(nextRef++)];
		const reviewerRef = hmac(nextRef++);
		for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
			const pairRef = hmac(nextRef++);
			const onFirst = pairIndex % 2 === 0;
			const projectIndex = pairIndex % projects.length;
			for (const sequence of [1, 2] as const) {
				tasks.push({
					participantRef,
					taskRef: hmac(nextRef++),
					sessionRef: hmac(nextRef++),
					projectRef: projects[projectIndex] as string,
					pairRef,
					reviewerRef,
					observedAt: observed((pairIndex % 12) * 7),
					condition: (sequence === 1) === onFirst ? "memory_on" : "memory_off",
					sequence,
					eligible: true,
					restrictedProject: projectIndex === 0,
					correctionRef: pairIndex < 2 && sequence === 1 ? (corrections[pairIndex] as string) : null,
					blindWinner: "memory",
				});
			}
		}
	}
	return {
		format: "doro-memory-study-evidence",
		version: 1,
		status,
		governance: {
			candidateCommit: "a".repeat(40),
			ethicsDecision: "approved",
			ethicsDecisionRef: sha("1"),
			protocolRef: sha("2"),
			consentFormRef: sha("3"),
			randomizationPlanRef: sha("4"),
			exitProcedureRef: sha("5"),
			dataControllerRef: hmac(nextRef++),
		},
		startedAt: observed(0),
		completedAt: status === "complete" ? observed(84) : null,
		participants,
		tasks,
	};
}

describe("Personal Memory real-study evidence", () => {
	it("reports 10-participant exposure without claiming that a real pilot started", () => {
		const report = evaluateMemoryStudyEvidence(evidence(10, "ongoing"));
		expect(report).toMatchObject({
			status: "ongoing",
			reportedCandidateCommit: "a".repeat(40),
			counts: { enrolledParticipants: 10, completedParticipants: 0, tasks: 20 },
			betaExposureComplete: true,
			stableExposureComplete: false,
			betaPilotStarted: false,
			stableStudyEligible: false,
			releaseBlockerCodes,
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("hmac-sha256:");
		expect(serialized).not.toContain("2026-");
	});

	it("labels the submitted candidate commit as reported and unbound", () => {
		const first = evidence(10, "ongoing");
		const second = evidence(10, "ongoing");
		second.governance.candidateCommit = "b".repeat(40);
		expect(evaluateMemoryStudyEvidence(first)).toMatchObject({
			reportedCandidateCommit: "a".repeat(40),
			releaseBlockerCodes: expect.arrayContaining(["CANDIDATE_COMMIT_UNBOUND"]),
		});
		expect(evaluateMemoryStudyEvidence(second).reportedCandidateCommit).toBe("b".repeat(40));
	});

	it("reports complete 30-participant exposure without stable eligibility", () => {
		const complete = evidence(30, "complete");
		if (complete.participants[0] === undefined) throw new Error("participant fixture missing");
		complete.participants[0].memoryDeletionRequested = true;
		complete.participants[0].memoryDeletionVerified = true;
		const report = evaluateMemoryStudyEvidence(complete);
		expect(report).toMatchObject({
			counts: { enrolledParticipants: 30, completedParticipants: 30, tasks: 1_200 },
			minimumsPerCompletedParticipant: {
				distinctWeeks: 12,
				distinctSessions: 40,
				distinctProjects: 3,
				distinctRestrictedProjects: 1,
				distinctCorrectionRefs: 2,
				eligibleTasks: 40,
			},
			balancedFirstConditionPerParticipant: true,
			eligiblePairBlindScoringCoverage: 1,
			betaExposureComplete: true,
			stableExposureComplete: true,
			betaPilotStarted: false,
			stableStudyEligible: false,
			releaseBlockerCodes,
		});
	});

	it("fails closed for a structurally valid forged-real v1 file", () => {
		const forged = evidence(30, "complete");
		forged.governance.candidateCommit = "f".repeat(40);
		const report = evaluateMemoryStudyEvidence(forged);
		expect(report).toMatchObject({
			reportedCandidateCommit: "f".repeat(40),
			betaExposureComplete: true,
			stableExposureComplete: true,
			betaPilotStarted: false,
			stableStudyEligible: false,
			releaseBlockerCodes,
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("hmac-sha256:");
		expect(serialized).not.toContain("2026-");
	});

	it("rejects self-reported aggregate fields and every extra field", () => {
		const maliciousField = "participant_name_Alice_secret";
		const rootAggregate = evidence(10, "ongoing") as MemoryStudyEvidenceV1 & Record<string, unknown>;
		rootAggregate[maliciousField] = 12;
		try {
			evaluateMemoryStudyEvidence(rootAggregate);
			throw new Error("expected malicious field rejection");
		} catch (error) {
			expect(String(error)).toContain("keys are invalid");
			expect(String(error)).not.toContain(maliciousField);
		}

		const participantAggregate = evidence(10, "ongoing");
		Object.assign(participantAggregate.participants[0] ?? {}, { sessionsObserved: 24 });
		expect(() => evaluateMemoryStudyEvidence(participantAggregate)).toThrow("keys are invalid");

		const incompletePair = evidence(10, "ongoing");
		const removedTask = incompletePair.tasks.pop();
		if (removedTask === undefined) throw new Error("task fixture missing");
		try {
			evaluateMemoryStudyEvidence(incompletePair);
			throw new Error("expected incomplete pair rejection");
		} catch (error) {
			expect(String(error)).toContain("exactly two tasks");
			expect(String(error)).not.toContain(removedTask.pairRef);
		}
	});

	it("rejects duplicate consent receipts and future study timestamps", () => {
		const duplicateConsent = evidence(10, "ongoing");
		if (duplicateConsent.participants[0] === undefined || duplicateConsent.participants[1] === undefined) {
			throw new Error("participant fixtures missing");
		}
		duplicateConsent.participants[1].consentReceiptRef = duplicateConsent.participants[0].consentReceiptRef;
		expect(() => evaluateMemoryStudyEvidence(duplicateConsent)).toThrow("duplicates consentReceiptRef");

		const futureStart = evidence(10, "ongoing");
		futureStart.startedAt = "2100-01-01T00:00:00.000Z";
		expect(() => evaluateMemoryStudyEvidence(futureStart)).toThrow("cannot be in the future");

		const futureTask = evidence(10, "ongoing");
		if (futureTask.tasks[0] === undefined || futureTask.tasks[1] === undefined)
			throw new Error("task fixtures missing");
		futureTask.tasks[0].observedAt = "2100-01-01T00:00:00.000Z";
		futureTask.tasks[1].observedAt = "2100-01-01T00:00:00.000Z";
		expect(() => evaluateMemoryStudyEvidence(futureTask)).toThrow("outside the study window");

		const futureCompletion = evidence(30, "complete");
		futureCompletion.completedAt = "2100-01-01T00:00:00.000Z";
		expect(() => evaluateMemoryStudyEvidence(futureCompletion)).toThrow("cannot be in the future");
	});

	it("requires active pilot participants with eligible pairs and independent reviewers", () => {
		const withdrawn = evidence(10, "ongoing");
		for (const participant of withdrawn.participants) participant.disposition = "withdrawn";
		expect(evaluateMemoryStudyEvidence(withdrawn).betaExposureComplete).toBe(false);

		const withoutTasks = evidence(10, "ongoing");
		withoutTasks.tasks = [];
		expect(evaluateMemoryStudyEvidence(withoutTasks).betaExposureComplete).toBe(false);

		const ineligibleParticipant = evidence(10, "ongoing");
		const participantRef = ineligibleParticipant.participants[0]?.participantRef;
		for (const task of ineligibleParticipant.tasks) {
			if (task.participantRef === participantRef) task.eligible = false;
		}
		expect(evaluateMemoryStudyEvidence(ineligibleParticipant).betaExposureComplete).toBe(false);

		const tenStartedOfEleven = evidence(11, "ongoing");
		const pendingParticipantRef = tenStartedOfEleven.participants[0]?.participantRef;
		for (const task of tenStartedOfEleven.tasks) {
			if (task.participantRef === pendingParticipantRef) task.eligible = false;
		}
		expect(evaluateMemoryStudyEvidence(tenStartedOfEleven)).toMatchObject({
			betaExposureComplete: true,
			betaPilotStarted: false,
		});

		const participantReviewer = evidence(10, "ongoing");
		const pairRef = participantReviewer.tasks[0]?.pairRef;
		const otherParticipantRef = participantReviewer.participants[1]?.participantRef;
		if (otherParticipantRef === undefined) throw new Error("participant fixture missing");
		for (const task of participantReviewer.tasks) {
			if (task.pairRef === pairRef) task.reviewerRef = otherParticipantRef;
		}
		expect(() => evaluateMemoryStudyEvidence(participantReviewer)).toThrow("independent of study participants");
	});

	it("fails closed for missing weeks, imbalance, unverified deletion, and incomplete blind scoring", () => {
		const missingWeeks = evidence(30, "complete");
		const firstParticipant = missingWeeks.participants[0]?.participantRef;
		for (const task of missingWeeks.tasks) {
			if (task.participantRef === firstParticipant) task.observedAt = observed(0);
		}
		expect(evaluateMemoryStudyEvidence(missingWeeks)).toMatchObject({
			minimumsPerCompletedParticipant: { distinctWeeks: 1 },
			stableExposureComplete: false,
		});

		const imbalanced = evidence(30, "complete");
		const imbalancedParticipant = imbalanced.participants[0]?.participantRef;
		for (const task of imbalanced.tasks) {
			if (task.participantRef !== imbalancedParticipant) continue;
			task.condition = task.sequence === 1 ? "memory_on" : "memory_off";
		}
		expect(evaluateMemoryStudyEvidence(imbalanced)).toMatchObject({
			balancedFirstConditionPerParticipant: false,
			stableExposureComplete: false,
		});

		const unverifiedDeletion = evidence(10, "ongoing");
		if (unverifiedDeletion.participants[0] === undefined) throw new Error("participant fixture missing");
		unverifiedDeletion.participants[0].memoryDeletionRequested = true;
		expect(() => evaluateMemoryStudyEvidence(unverifiedDeletion)).toThrow("not consistently verified");

		const unscored = evidence(30, "complete");
		const pairRef = unscored.tasks[0]?.pairRef;
		for (const task of unscored.tasks) {
			if (task.pairRef === pairRef) task.blindWinner = "not_scored";
		}
		expect(evaluateMemoryStudyEvidence(unscored)).toMatchObject({
			eligiblePairBlindScoringCoverage: 0.998333,
			stableExposureComplete: false,
		});
	});

	it("rejects reversed timestamps within a paired task", () => {
		const reversed = evidence(10, "ongoing");
		const pairRef = reversed.tasks[0]?.pairRef;
		for (const task of reversed.tasks) {
			if (task.pairRef !== pairRef) continue;
			task.observedAt = task.sequence === 1 ? observed(1) : observed(0);
		}
		expect(() => evaluateMemoryStudyEvidence(reversed)).toThrow("timestamps are reversed");
	});

	it("does not use non-contiguous or post-week-12 tasks to satisfy stable minima", () => {
		const extended = evidence(30, "complete");
		extended.completedAt = observed(112);
		const participantRef = extended.participants[0]?.participantRef;
		for (const task of extended.tasks) {
			if (task.participantRef === participantRef && task.observedAt === observed(77)) task.observedAt = observed(91);
		}
		expect(evaluateMemoryStudyEvidence(extended)).toMatchObject({
			minimumsPerCompletedParticipant: { distinctWeeks: 11 },
			stableExposureComplete: false,
		});
	});
});
