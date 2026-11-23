import { z } from 'zod';
import { FORM_FIELD_KEYS, STORYBOARD_SCREENS } from './action-board-catalog';

/** What each board worker may write. Server-only: the page imports types from the catalog instead. */

export const labelSchema = (enMax: number, zhMax: number) =>
  z.object({ en: z.string().min(2).max(enMax), zh: z.string().min(1).max(zhMax) });

/** Required so models always write it; loose max so an over-long line is dropped by acceptWhy instead of failing the card. */
const whySchema = z.object({ en: z.string().min(6).max(240), zh: z.string().min(4).max(120) });

export const docDraftModelSchema = z.object({
  whyDoThis: whySchema,
  title: z.string().min(6).max(150),
  tldr: z.string().min(20).max(520),
  verdict: z
    .object({
      ownHeadline: z.string().min(6).max(110),
      ownPoints: z.array(z.string().min(6).max(140)).min(2).max(4),
      saasHeadline: z.string().min(6).max(110),
      saasPoints: z.array(z.string().min(6).max(140)).min(2).max(4),
    })
    .optional(),
  bestFor: z
    .array(
      z.object({
        product: z.string().min(1).max(40),
        badge: z.string().min(2).max(48),
        idealFor: z.string().min(12).max(180),
        tradeOff: z.string().min(8).max(160),
      }),
    )
    .min(2)
    .max(4)
    .optional(),
  workflow: z
    .object({
      traditionalTitle: z.string().min(4).max(70),
      traditionalSteps: z.array(z.string().min(4).max(80)).min(3).max(4),
      ownTitle: z.string().min(4).max(70),
      ownSteps: z.array(z.string().min(4).max(80)).min(3).max(4),
    })
    .optional(),
  table: z.object({
    products: z.array(z.string().min(1).max(40)).min(2).max(4),
    rows: z
      .array(z.object({ dimension: z.string().min(2).max(48), cells: z.array(z.string().min(1).max(120)).min(2).max(4) }))
      .min(3)
      .max(8),
  }),
  sections: z
    .array(
      z.object({
        heading: z.string().min(3).max(80),
        questionId: z.string().max(40).optional(),
        body: z.string().min(40).max(1800),
      }),
    )
    .min(3)
    .max(7),
  claims: z
    .array(
      z.object({
        text: z.string().min(6).max(240),
        about: z.string().min(1).max(40),
        sourceUrl: z.string().max(400).nullable(),
      }),
    )
    .max(8),
});

export const communityReplyModelSchema = z.object({
  whyDoThis: whySchema,
  threads: z
    .array(
      z.object({
        url: z.string().min(8).max(400),
        angle: labelSchema(70, 30),
        body: z.string().min(120).max(1300),
        disclosure: z.string().min(20).max(220),
      }),
    )
    .min(1)
    .max(4),
});


export const videoScriptModelSchema = z.object({
  whyDoThis: whySchema,
  titles: z.array(z.string().min(8).max(100)).min(2).max(3),
  thumbText: z.string().min(2).max(40),
  descriptionIntro: z.string().min(20).max(420),
  beats: z
    .array(
      z.object({
        t: z.string().min(3).max(8),
        screen: z.enum(STORYBOARD_SCREENS),
        shot: labelSchema(100, 44),
        onScreen: z.string().min(2).max(60),
        lines: z.array(z.string().min(4).max(220)).min(1).max(3),
      }),
    )
    .min(4)
    .max(6),
});


export const formPackModelSchema = z.object({
  whyDoThis: whySchema,
  fields: z
    .array(z.object({ key: z.enum(FORM_FIELD_KEYS), value: z.string().min(1).max(700) }))
    .min(4)
    .max(8),
});

export const prPatchModelSchema = z.object({
  whyDoThis: whySchema,
  targets: z
    .array(
      z.object({
        repoUrl: z.string().min(8).max(300),
        section: z.string().max(80).optional(),
        entryLine: z.string().min(6).max(320),
        prTitle: z.string().min(6).max(90),
        prBody: z.string().min(20).max(900),
      }),
    )
    .min(1)
    .max(3),
});

export const editLabelsModelSchema = z.object({
  whyDoThis: whySchema,
  edits: z
    .array(z.object({ findingId: z.string().min(1).max(40), title: labelSchema(70, 30), why: labelSchema(130, 56) }))
    .min(1)
    .max(6),
});

export const outreachEmailModelSchema = z.object({
  whyDoThis: whySchema,
  targets: z
    .array(
      z.object({
        siteName: z.string().min(2).max(120),
        subject: z.string().min(8).max(160),
        body: z.string().min(60).max(1600),
        blurb: z.string().min(30).max(360),
      }),
    )
    .min(1)
    .max(4),
});
