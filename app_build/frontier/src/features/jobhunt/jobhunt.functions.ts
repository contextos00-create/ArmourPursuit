import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

const id = z.string().min(4).max(40)
const strings = z.array(z.string().max(120)).max(80)

const settingsSchema = z.object({
  targetTitles: strings,
  titleKeywords: strings,
  excludeTitleKeywords: strings,
  locations: strings,
  workModes: z.array(z.enum(["remote", "hybrid", "onsite"])).max(3),
  seniority: z.enum(["", "junior", "mid", "senior", "staff"]),
  salaryFloor: z.number(),
  usOnly: z.boolean(),
  needsSponsorship: z.boolean(),
  blockedCompanies: strings,
  dreamCompanies: strings,
  watchlist: z.array(z.object({ ats: z.enum(["greenhouse", "lever", "ashby"]), slug: z.string().max(60), name: z.string().max(80) })).max(200),
  adzunaWhat: strings,
  adzunaWhere: strings,
  adzunaMaxDaysOld: z.number(),
  dailyTarget: z.number(),
  autoTailorAt: z.number(),
  approvalAt: z.number(),
  hotScore: z.number(),
  hotExtra: z.number(),
  perCompany: z.number(),
  maxSiteFailures: z.number(),
  applyWaitMinutes: z.number(),
  applyWindow: z.enum(["auto", "visible", "hidden"]),
  autoSubmit: z.boolean(),
  discoveryEveryMinutes: z.number(),
  inboxEveryMinutes: z.number(),
  activeStart: z.number(),
  activeEnd: z.number(),
  digestHour: z.number(),
  digestMinute: z.number(),
  agentInstructions: z.string().max(2000),
  notifyEnabled: z.boolean(),
  notifySms: z.boolean(),
  notifyBrowser: z.boolean(),
  notifyOff: z.array(z.string().max(30)).max(20),
  quietEnabled: z.boolean(),
  quietStart: z.number(),
  quietEnd: z.number(),
  quietUrgent: z.boolean(),
})

export const getAccess = createServerFn({ method: "GET" }).handler(async () => {
  const { accessState } = await import("./jobhunt.server")
  return accessState()
})

export const unlockCommandCenter = createServerFn({ method: "POST" })
  .validator(z.object({ passcode: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const { unlock } = await import("./jobhunt.server")
    return unlock(data.passcode)
  })

export const setPhonePasscode = createServerFn({ method: "POST" })
  .validator(z.object({ passcode: z.string().max(200).nullable() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter({ localOnly: true }).remoteSetPasscode(data.passcode)
  })

export const getCommandCenter = createServerFn({ method: "GET" }).handler(
  async () => {
    const { commandCenter, isLocalRequest } = await import("./jobhunt.server")
    return { ...commandCenter().state(), local: isLocalRequest() }
  }
)

export const saveAgentSettings = createServerFn({ method: "POST" })
  .validator(
    z.object({
      provider: z.enum(["anthropic", "openai", "openai-compatible"]),
      model: z.string().max(120).optional(),
      apiKey: z.string().max(400).nullable().optional(),
      baseURL: z.string().url().max(300).nullable().optional(),
    })
  )
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    // The key and where it is sent can only be changed on the computer itself.
    return commandCenter({ localOnly: true }).saveConfig(data)
  })

export const saveJobSettings = createServerFn({ method: "POST" })
  .validator(settingsSchema)
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().saveSettings(data)
  })

export const sendAgentMessage = createServerFn({ method: "POST" })
  .validator(z.object({ text: z.string().min(1).max(4000) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().send(data.text)
  })

export const applyAgentProposal = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(4).max(20) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: await commandCenter().apply(data.id) }
  })

export const dismissAgentProposal = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(4).max(20) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    commandCenter().dismiss(data.id)
    return { ok: true }
  })

export const clearAgentChat = createServerFn({ method: "POST" }).handler(
  async () => {
    const { commandCenter } = await import("./jobhunt.server")
    commandCenter().clear()
    return { ok: true }
  }
)

export const readJobDocument = createServerFn({ method: "POST" })
  .validator(z.object({ path: z.string().min(3).max(300) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().readDocument(data.path)
  })

export const applicationAction = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id,
      action: z.enum([
        "approve", "skip", "applied", "saved", "tailored", "acknowledged", "assessment", "screening", "interviewing", "offer",
        "accepted", "rejected", "withdrawn", "ghosted", "bounced",
      ]),
    })
  )
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: await commandCenter().applicationAction(data.id, data.action) }
  })

export const addJobPosting = createServerFn({ method: "POST" })
  .validator(z.object({ url: z.string().url().startsWith("https://").max(500) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: await commandCenter().addPosting(data.url) }
  })

export const runAutomation = createServerFn({ method: "POST" })
  .validator(z.object({ action: z.enum(["pause", "resume", "discover", "inbox"]) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: await commandCenter().automation(data.action) }
  })

export const saveBankAnswer = createServerFn({ method: "POST" })
  .validator(z.object({ question: z.string().min(2).max(300), answer: z.string().max(500) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().saveBankAnswer(data.question, data.answer) }
  })

export const answerPendingQuestion = createServerFn({ method: "POST" })
  .validator(z.object({ id, n: z.number().int().min(1).max(50), answer: z.string().min(1).max(500) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().answerPending(data.id, data.n, data.answer) }
  })

export const startApplySession = createServerFn({ method: "POST" })
  .validator(z.object({ id, narrow: z.boolean() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: await commandCenter().startApply(data.id, { narrow: data.narrow }) }
  })

export const getApplySession = createServerFn({ method: "POST" })
  .validator(z.object({ image: z.boolean() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().applyView(data.image)
  })

export const sendApplyInput = createServerFn({ method: "POST" })
  .validator(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("click"), x: z.number().min(0).max(4000), y: z.number().min(0).max(4000) }),
      z.object({ type: z.literal("type"), text: z.string().min(1).max(2000) }),
      z.object({ type: z.literal("key"), key: z.string().max(20) }),
      z.object({ type: z.literal("scroll"), dy: z.number().min(-2000).max(2000) }),
      z.object({ type: z.literal("select"), x: z.number().min(0).max(4000), y: z.number().min(0).max(4000), value: z.string().max(300) }),
      z.object({ type: z.literal("viewport"), narrow: z.boolean() }),
    ])
  )
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().applyInput(data)
  })

export const submitApplySession = createServerFn({ method: "POST" }).handler(async () => {
  const { commandCenter } = await import("./jobhunt.server")
  return { message: await commandCenter().applySubmit() }
})

export const stopApplySession = createServerFn({ method: "POST" }).handler(async () => {
  const { commandCenter } = await import("./jobhunt.server")
  await commandCenter().applyStop()
  return { ok: true }
})

export const savePrepNotes = createServerFn({ method: "POST" })
  .validator(z.object({ id, notes: z.record(z.string().max(12), z.string().max(2000)), practiced: z.array(z.string().max(300)).max(60) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().savePrep(data.id, { notes: data.notes, practiced: data.practiced }) }
  })

export const openPrepPack = createServerFn({ method: "POST" })
  .validator(z.object({ id }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().readDocument(commandCenter().prepDocument(data.id))
  })

export const importConnections = createServerFn({ method: "POST" })
  .validator(z.object({ csv: z.string().min(20).max(6_000_000) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().saveConnections(data.csv) }
  })

const line = z.string().max(600)
const profileSchema = z.object({
  name: z.string().max(120),
  label: z.string().max(120),
  email: z.string().max(160),
  phone: z.string().max(40),
  city: z.string().max(80),
  region: z.string().max(80),
  summary: z.string().max(1500),
  work: z.array(z.object({ name: z.string().max(120), position: z.string().max(120), startDate: z.string().max(20), endDate: z.string().max(20), highlights: z.array(line).max(30) })).max(20),
  education: z.array(z.object({ institution: z.string().max(160), studyType: z.string().max(80), area: z.string().max(120), endDate: z.string().max(20) })).max(10),
  skills: z.array(z.string().max(60)).max(80),
})

export const saveProfile = createServerFn({ method: "POST" })
  .validator(profileSchema)
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().saveProfile(data) }
  })

export const importResumeJson = createServerFn({ method: "POST" })
  .validator(z.object({ text: z.string().min(2).max(400_000) }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().importResumeJson(data.text) }
  })

export const completeSetup = createServerFn({ method: "POST" }).handler(async () => {
  const { commandCenter } = await import("./jobhunt.server")
  return { message: commandCenter().completeSetup() }
})

export const getNotifications = createServerFn({ method: "GET" }).handler(async () => {
  const { commandCenter } = await import("./jobhunt.server")
  return commandCenter().notifications()
})

export const sendTestNotification = createServerFn({ method: "POST" }).handler(async () => {
  const { commandCenter } = await import("./jobhunt.server")
  return { message: await commandCenter().testNotification() }
})

// ── Reply workshop ─────────────────────────────────────────────────────────

const replyKind = z.enum(["outreach", "confirmation", "assessment", "interview", "rejection", "thankyou", "followup"])
const replyRule = z.object({ on: z.boolean(), delayHours: z.number(), subject: z.string().max(200), body: z.string().max(4000) })
const replyRules = z.object({
  enabled: z.boolean(),
  rules: z.object({ outreach: replyRule, confirmation: replyRule, assessment: replyRule, interview: replyRule, rejection: replyRule, thankyou: replyRule, followup: replyRule }),
  followup: z.object({ firstDays: z.number(), everyDays: z.number(), max: z.number(), weekdaysOnly: z.boolean() }),
})

export const saveReplyRules = createServerFn({ method: "POST" })
  .validator(replyRules)
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().saveReplyRules(data) }
  })

export const resetReplyRule = createServerFn({ method: "POST" })
  .validator(z.object({ kind: replyKind }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().resetReplyRule(data.kind) }
  })

export const previewReply = createServerFn({ method: "POST" })
  .validator(z.object({ kind: replyKind, applicationId: id.nullable(), rules: replyRules.nullable() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().previewReply(data.kind, data.applicationId, data.rules)
  })

/** One button press on one draft. "send" emails that single draft and nothing else. */
export const replyDraftAction = createServerFn({ method: "POST" })
  .validator(z.object({
    id: z.string().min(8).max(60),
    action: z.enum(["save", "send", "gmail", "done", "dismiss", "snooze"]),
    to: z.string().max(200).optional(), subject: z.string().max(200).optional(), body: z.string().max(6000).optional(), days: z.number().int().min(1).max(30).optional(),
  }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    const { id: draftId, action, ...input } = data
    return { message: await commandCenter().replyAction(draftId, action, input) }
  })

export const composeReply = createServerFn({ method: "POST" })
  .validator(z.object({ id, kind: replyKind }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: await commandCenter().composeReply(data.id, data.kind) }
  })

export const pauseFollowups = createServerFn({ method: "POST" })
  .validator(z.object({ id, paused: z.boolean() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return { message: commandCenter().pauseFollowups(data.id, data.paused) }
  })

// ── Resume workshop ────────────────────────────────────────────────────────

const resumeChoices = z.object({
  headline: z.string().max(120).nullable(),
  summaryMode: z.enum(["master", "targeted", "custom"]),
  summaryText: z.string().max(1500),
  bullets: z.record(z.string().max(8), z.object({ on: z.boolean().optional(), text: z.string().max(600).optional() })),
  pinned: z.array(z.string().max(8)).max(60),
  rolesOff: z.array(z.string().max(4)).max(30),
  skillsOff: z.array(z.string().max(60)).max(120),
  notes: z.string().max(6000),
  dropSuggestions: z.array(z.string().max(8)).max(60).optional(),
})
const urls = z.array(z.string().max(400)).max(4)

export const getResumeWorkshop = createServerFn({ method: "POST" })
  .validator(z.object({ id }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().resumeWorkshop(data.id)
  })

export const saveResumeChoices = createServerFn({ method: "POST" })
  .validator(z.object({ id, choices: resumeChoices }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().saveResumeChoices(data.id, data.choices)
  })

export const resumeWorkshopAction = createServerFn({ method: "POST" })
  .validator(z.object({ id, action: z.enum(["suggest", "research", "agent", "save", "reset"]), lines: z.array(z.string().max(8)).max(12).optional(), urls: urls.optional() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    const cc = commandCenter()
    if (data.action === "suggest") return cc.resumeSuggest(data.id, data.lines ?? [])
    if (data.action === "research") return cc.resumeResearch(data.id, data.urls ?? [])
    if (data.action === "agent") return cc.resumeAgentPass(data.id, data.urls ?? [])
    if (data.action === "save") return cc.resumeSaveVersion(data.id)
    return cc.resumeReset(data.id)
  })

// ── Game plan (role brief, skill builder, plan of attack, coach) ───────────

const planInput = z.object({
  dates: z.array(z.object({
    id: z.string().max(16), kind: z.enum(["screen", "interview", "assessment", "other"]), label: z.string().max(80),
    at: z.number(), minutes: z.number().min(10).max(480), remind: z.array(z.number()).max(6),
  })).max(13),
  done: z.array(z.string().max(60)).max(300),
  confidence: z.record(z.string().max(40), z.number().min(1).max(5)),
  processNotes: z.string().max(3000),
  profile: z.object({
    concerns: z.array(z.object({ topic: z.string().max(80), key: z.string().max(20).nullable(), level: z.enum(["low", "medium", "high"]), note: z.string().max(300) })).max(8),
    focus: z.array(z.string().max(140)).max(6),
    style: z.string().max(240),
  }),
})

export const getGamePlan = createServerFn({ method: "POST" })
  .validator(z.object({ id }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().gamePlan(data.id)
  })

export const saveGamePlan = createServerFn({ method: "POST" })
  .validator(z.object({ id, plan: planInput }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    return commandCenter().saveGamePlan(data.id, data.plan)
  })

export const gamePlanAction = createServerFn({ method: "POST" })
  .validator(z.object({ id, action: z.enum(["coach", "clear", "questions"]), text: z.string().max(2000).optional() }))
  .handler(async ({ data }) => {
    const { commandCenter } = await import("./jobhunt.server")
    const cc = commandCenter()
    if (data.action === "coach") return cc.coachSend(data.id, data.text ?? "")
    if (data.action === "questions") return cc.planQuestions(data.id)
    return { message: "Conversation cleared.", view: cc.coachClear(data.id) }
  })

// ── Model readiness check ──────────────────────────────────────────────────

export const runModelCheck = createServerFn({ method: "POST" }).handler(async () => {
  const { commandCenter } = await import("./jobhunt.server")
  return commandCenter().runModelCheck()
})
