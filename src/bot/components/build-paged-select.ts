import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';

/** Discord's hard cap on select-menu options. */
export const OPTIONS_PER_PAGE = 25;

/** Labels are truncated well below the 100-char cap: Discord's UI clips long ones with no hover reveal. */
const MAX_LABEL = 40;
const MAX_DESCRIPTION = 90;

export type SelectItem = { value: string; label: string; description?: string };

export type PagedSelect = {
  select: ActionRowBuilder<StringSelectMenuBuilder>;
  nav: ActionRowBuilder<ButtonBuilder> | null;
  page: number;
  totalPages: number;
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Builds a paginated select menu with navigation buttons.
 *
 * All state lives in the custom_id, handled by a single global interactionCreate
 * listener. A MessageComponentCollector would be in-memory only: after a timeout
 * or a process restart the buttons remain on the message with nothing listening,
 * and every click answers "This interaction failed". Encoding state removes the
 * timeout branch entirely — expiry cannot happen.
 *
 * customId budget is 100 characters, so the ids passed in must stay short
 * (numeric row ids, not names).
 */
export function buildPagedSelect(input: {
  items: SelectItem[];
  page: number;
  selectId: string;
  navPrefix: string;
  placeholder: string;
}): PagedSelect {
  const totalPages = Math.max(1, Math.ceil(input.items.length / OPTIONS_PER_PAGE));
  const page = Math.min(Math.max(input.page, 0), totalPages - 1);
  const slice = input.items.slice(page * OPTIONS_PER_PAGE, page * OPTIONS_PER_PAGE + OPTIONS_PER_PAGE);

  const select = new StringSelectMenuBuilder()
    .setCustomId(input.selectId)
    .setPlaceholder(clip(totalPages > 1 ? `${input.placeholder} (${page + 1}/${totalPages})` : input.placeholder, 150))
    .addOptions(
      slice.map((item) => ({
        label: clip(item.label, MAX_LABEL),
        value: item.value.slice(0, 100),
        ...(item.description ? { description: clip(item.description, MAX_DESCRIPTION) } : {}),
      })),
    );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  if (totalPages <= 1) return { select: selectRow, nav: null, page, totalPages };

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${input.navPrefix}:${page - 1}`)
      .setLabel('‹ Trước')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${input.navPrefix}:noop`)
      .setLabel(`${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${input.navPrefix}:${page + 1}`)
      .setLabel('Sau ›')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );

  return { select: selectRow, nav, page, totalPages };
}

/** Rows for a reply payload, omitting the nav row when there is only one page. */
export function toComponents(paged: PagedSelect): (
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<ButtonBuilder>
)[] {
  return paged.nav ? [paged.select, paged.nav] : [paged.select];
}
