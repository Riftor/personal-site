import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectCard from './ProjectCard.svelte';

describe('ProjectCard.svelte', () => {
	it('renders the title at the requested heading level, with the date and summary', async () => {
		render(ProjectCard, {
			title: 'Project One',
			summary: 'What it was and what changed.',
			occurredOn: '2026-05-01',
			level: 2
		});

		await expect.element(page.getByRole('heading', { level: 2 })).toHaveTextContent('Project One');
		await expect.element(page.getByText('May 2026')).toBeInTheDocument();
		await expect.element(page.getByText('What it was and what changed.')).toBeInTheDocument();
	});

	it('omits the date line when the entry has no occurred_on', async () => {
		render(ProjectCard, { title: 'Project Two' });

		await expect.element(page.getByRole('heading', { level: 3 })).toHaveTextContent('Project Two');
		expect(document.querySelector('time')).toBeNull();
	});
});
