import { expect, test } from '@playwright/test';

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

test('runs tRPC queries, mutations, and a cancellable subscription over WebRTC', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    browserErrors.push(error.message);
  });

  await page.goto('/');

  const status = page.locator('#status');
  const output = page.locator('#output');
  const hello = page.getByRole('button', { name: 'hello.query()' });
  const increment = page.getByRole('button', {
    name: 'counter.increment.mutate()',
  });
  const clock = page.getByRole('button', { name: 'clock.subscribe()' });
  const cancel = page.getByRole('button', { name: 'Cancel subscription' });

  await expect(status).toHaveText('Connected');
  await expect(output).toContainText('Hello from Node peer');

  await hello.click();
  await expect
    .poll(async () => countOccurrences((await output.textContent()) ?? '', 'Hello from Node peer'))
    .toBe(2);

  await increment.click();
  await expect(output).toContainText(/"counter": \d+/);

  await clock.click();
  await expect(output).toContainText('clock subscription started');
  await expect
    .poll(async () => countOccurrences((await output.textContent()) ?? '', '"clock":'))
    .toBeGreaterThanOrEqual(2);

  await cancel.click();
  await expect(cancel).toBeDisabled();
  await expect(output).toContainText('clock subscription cancelled');

  const valuesAfterCancellation = countOccurrences((await output.textContent()) ?? '', '"clock":');
  await page.waitForTimeout(1_250);
  expect(countOccurrences((await output.textContent()) ?? '', '"clock":')).toBe(
    valuesAfterCancellation,
  );
  expect(browserErrors).toEqual([]);
});
