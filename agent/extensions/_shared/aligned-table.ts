export type TableAlignment = "left" | "right";

export type AlignedColumn<Key extends string = string> = {
	key: Key;
	align?: TableAlignment;
	/** Lowest useful width when the table has to shrink. */
	minWidth?: number;
	/** Prevent a long value from consuming the whole row. */
	maxWidth?: number;
	/** Larger values are shrunk first when space is tight. */
	shrinkPriority?: number;
	/** Allow this column to disappear on very narrow terminals. */
	optional?: boolean;
	/** Larger values are hidden first when shrinking is not enough. */
	hidePriority?: number;
};

type TableRow<Key extends string> = Readonly<Record<Key, string>>;

type ColumnState<Key extends string> = {
	column: AlignedColumn<Key>;
	width: number;
	floor: number;
};

export type TableRenderOptions = {
	gap?: string;
	visibleWidth: (value: string) => number;
	truncate: (value: string, width: number) => string;
};

function totalWidth<Key extends string>(states: readonly ColumnState<Key>[], gapWidth: number): number {
	return states.reduce((sum, state) => sum + state.width, 0) + Math.max(0, states.length - 1) * gapWidth;
}

function createStates<Key extends string>(
	rows: readonly TableRow<Key>[],
	columns: readonly AlignedColumn<Key>[],
	visibleWidth: (value: string) => number,
): ColumnState<Key>[] {
	return columns
		.filter((column) => rows.some((row) => visibleWidth(row[column.key] ?? "") > 0))
		.map((column) => {
			const contentWidth = rows.reduce((maximum, row) => Math.max(maximum, visibleWidth(row[column.key] ?? "")), 0);
			const width = column.maxWidth === undefined ? contentWidth : Math.min(contentWidth, Math.max(0, column.maxWidth));
			return {
				column,
				width,
				// Do not widen a naturally short column just to satisfy its compact
				// fallback width. The floor only matters once shrinking starts.
				floor: Math.min(width, Math.max(0, column.minWidth ?? 0)),
			};
		});
}

function shrinkToFit<Key extends string>(states: ColumnState<Key>[], availableWidth: number, gapWidth: number): void {
	let excess = totalWidth(states, gapWidth) - availableWidth;
	if (excess <= 0) return;

	const candidates = [...states]
		.sort((left, right) => {
			const priority = (right.column.shrinkPriority ?? 0) - (left.column.shrinkPriority ?? 0);
			return priority || right.width - left.width;
		})
		.filter((state) => state.width > state.floor);

	for (const state of candidates) {
		if (excess <= 0) break;
		const available = state.width - state.floor;
		const reduction = Math.min(available, excess);
		state.width -= reduction;
		excess -= reduction;
	}
}

function forceFit<Key extends string>(states: ColumnState<Key>[], availableWidth: number, gapWidth: number): void {
	let excess = totalWidth(states, gapWidth) - availableWidth;
	if (excess <= 0) return;

	// This is only a last-resort guard for extremely small terminals. Preserve
	// the same priority order, but let essential columns shrink below their
	// normal floor rather than allowing the table to overflow.
	const candidates = [...states]
		.sort((left, right) => {
			const priority = (right.column.shrinkPriority ?? 0) - (left.column.shrinkPriority ?? 0);
			return priority || right.width - left.width;
		})
		.filter((state) => state.width > 0);
	for (const state of candidates) {
		if (excess <= 0) break;
		const reduction = Math.min(state.width, excess);
		state.width -= reduction;
		excess -= reduction;
	}
}

/**
 * Render rows using widths calculated from the complete visible data set.
 * ANSI-styled values are supported as long as the supplied width/truncation
 * functions understand them.
 */
export function renderAlignedTable<Key extends string>(
	rows: readonly TableRow<Key>[],
	availableWidth: number,
	columns: readonly AlignedColumn<Key>[],
	options: TableRenderOptions,
): string[] {
	if (rows.length === 0) return [];

	const gap = options.gap ?? "  ";
	const gapWidth = options.visibleWidth(gap);
	const finiteWidth = Number.isFinite(availableWidth) ? Math.max(0, Math.floor(availableWidth)) : Number.POSITIVE_INFINITY;
	let selected = columns.filter((column) => rows.some((row) => options.visibleWidth(row[column.key] ?? "") > 0));
	let states = createStates(rows, selected, options.visibleWidth);

	while (finiteWidth !== Number.POSITIVE_INFINITY && totalWidth(states, gapWidth) > finiteWidth) {
		shrinkToFit(states, finiteWidth, gapWidth);
		if (totalWidth(states, gapWidth) <= finiteWidth) break;

		const optional = states
			.filter((state) => state.column.optional)
			.sort((left, right) => (right.column.hidePriority ?? 0) - (left.column.hidePriority ?? 0));
		const toHide = optional[0];
		if (!toHide) break;
		selected = selected.filter((column) => column.key !== toHide.column.key);
		states = createStates(rows, selected, options.visibleWidth);
	}

	if (finiteWidth !== Number.POSITIVE_INFINITY) forceFit(states, finiteWidth, gapWidth);
	states = states.filter((state) => state.width > 0);
	const activeColumns = states.map((state) => state.column);
	const widths = new Map(states.map((state) => [state.column.key, state.width]));

	return rows.map((row) => {
		const cells = activeColumns.map((column, index) => {
			const width = widths.get(column.key) ?? 0;
			const value = options.truncate(row[column.key] ?? "", width);
			const padding = Math.max(0, width - options.visibleWidth(value));
			// The last cell has no following column to align, so avoid trailing
			// spaces while retaining padding everywhere else.
			if (index === activeColumns.length - 1) return value;
			return column.align === "right"
				? `${" ".repeat(padding)}${value}`
				: `${value}${" ".repeat(padding)}`;
		});
		const rendered = cells.join(gap);
		return finiteWidth !== Number.POSITIVE_INFINITY && options.visibleWidth(rendered) > finiteWidth
			? options.truncate(rendered, finiteWidth)
			: rendered;
	});
}

/**
 * Render one aligned table with a variable tree prefix in its first column.
 *
 * The prefix belongs to the tree/connector column, rather than to the whole
 * row. This keeps the data columns aligned while still letting connectors move
 * to the right as the tree gets deeper.
 */
export function renderIndentedAlignedTable<Key extends string>(
	rows: readonly Readonly<Record<Key, string>>[],
	availableWidth: number,
	columns: readonly AlignedColumn<Key>[],
	options: TableRenderOptions,
	indent: (row: Readonly<Record<Key, string>>) => string,
): string[] {
	const firstColumn = columns[0]?.key;
	if (!firstColumn) return rows.map((row) => indent(row));

	const indentedRows = rows.map((row) => ({
		...row,
		[firstColumn]: `${indent(row)}${row[firstColumn] ?? ""}`,
	}));
	return renderAlignedTable(indentedRows, availableWidth, columns, options);
}
