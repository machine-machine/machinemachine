import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    author: z.string().default('MachineMachine'),
    tags: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    linkedinReady: z.boolean().default(false),
  }),
});

export const collections = { blog };
