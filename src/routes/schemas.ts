import { z } from 'zod';
import { hasLongNumber } from '../lib/longNumber.js';

export const questionSetSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .trim()
          .min(3, 'Each question needs a few more words.')
          .max(200)
          .refine((question) => !hasLongNumber(question), {
            message: 'Please do not put card or account numbers in a question.',
          }),
        answer: z
          .string()
          .trim()
          .min(1, 'Every question needs an answer.')
          .max(200)
          .refine((answer) => !hasLongNumber(answer), {
            message: 'Please do not use card or account numbers as answers.',
          }),
      }),
    )
    .min(1, 'Add at least one question.')
    .max(10, 'Ten questions is the most you can keep.')
    .refine((qs) => new Set(qs.map((q) => q.question.toLowerCase())).size === qs.length, {
      message: 'Each question can only appear once.',
    }),
});

export const answerSchema = z.object({
  answer: z.string().min(1, 'Type an answer first.').max(200),
});

export const recoveryRequestSchema = z.object({
  kind: z.enum(['normal', 'super']),
});
