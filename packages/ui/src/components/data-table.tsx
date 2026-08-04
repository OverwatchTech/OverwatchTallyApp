import type { ReactNode } from 'react';
import { cx } from './util';

export interface DataTableColumn<Row> {
  /** Stable key for the column. */
  key: string;
  header: ReactNode;
  /** Right-align the column — do this for every number. */
  align?: 'left' | 'right';
  /** Render the cell in mono with tabular figures. Do this for every number. */
  mono?: boolean;
  /** Extra class on the `<td>` only. */
  cellClassName?: string;
  width?: string;
  cell: (row: Row, index: number) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: Array<DataTableColumn<Row>>;
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  /** Shown in place of the table body when `rows` is empty. */
  empty?: ReactNode;
  /** Adds a scroll container at this height, e.g. `290` or `'40vh'`. */
  maxHeight?: number | string;
  rowClassName?: (row: Row, index: number) => string | undefined;
  /** Visually hidden caption. Give every table one. */
  caption?: string;
  className?: string;
}

/**
 * Uppercase micro-headers, 8.5px row padding, hairline rules, 2.5% white
 * row hover. `mono` and `align:'right'` are the number modifiers.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty,
  maxHeight,
  rowClassName,
  caption,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0 && empty !== undefined) {
    return <div className="ow-note">{empty}</div>;
  }

  const table = (
    <table className={cx('ow-table', className)}>
      {caption ? (
        <caption
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {caption}
        </caption>
      ) : null}
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              className={cx(col.align === 'right' && 'r')}
              style={col.width ? { width: col.width } : undefined}
            >
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={rowKey(row, index)} className={rowClassName?.(row, index)}>
            {columns.map((col) => (
              <td
                key={col.key}
                className={cx(col.mono && 'mono', col.align === 'right' && 'r', col.cellClassName)}
              >
                {col.cell(row, index)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (maxHeight !== undefined) {
    return (
      <div className="ow-tablescroll" style={{ maxHeight }}>
        {table}
      </div>
    );
  }
  return table;
}
