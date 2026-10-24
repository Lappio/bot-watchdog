import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { MoreHorizontal, ArrowUpDown, Plus } from "lucide-react";
import type { ScheduleItem } from "@/lib/api";
import { relative, taskStatus } from "@/lib/helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
export function DataTable({
  tasks,
  onAction,
  onNew,
}: {
  tasks: ScheduleItem[];
  onAction: (action: string, id: string) => void;
  onNew: () => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("All");
  const data = useMemo(
    () => tasks.filter((t) => status === "All" || taskStatus(t) === status),
    [tasks, status],
  );
  const columns: ColumnDef<ScheduleItem>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <a
            className="font-medium hover:underline"
            href={`#/tasks/${row.original.id}`}
          >
            {row.original.name}
          </a>
        ),
      },
      {
        accessorKey: "bot",
        header: "Bot",
        cell: ({ getValue }) => String(getValue() ?? "—"),
      },
      {
        accessorKey: "schedule",
        header: "Schedule",
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.schedule}
            <span className="block text-muted-foreground">
              {row.original.timezone}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "next_run",
        header: "Next run",
        cell: ({ getValue }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{relative(getValue() as string | null)}</span>
            </TooltipTrigger>
            <TooltipContent>
              {String(getValue() ?? "No next occurrence")}
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        accessorKey: "last_heartbeat_at",
        header: "Last heartbeat",
        cell: ({ getValue }) => (
          <span title={String(getValue() ?? "")}>
            {relative(getValue() as string | null)}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: taskStatus,
        header: "Status",
        cell: ({ getValue }) => (
          <Badge
            variant={
              getValue() === "Healthy"
                ? "secondary"
                : getValue() === "Paused"
                  ? "outline"
                  : "destructive"
            }
          >
            {String(getValue())}
          </Badge>
        ),
      },
      {
        id: "incidents",
        accessorFn: (t) => t.open_incidents.length,
        header: "Open incidents",
      },
      {
        id: "actions",
        enableSorting: false,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${row.original.name}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {[
                "View",
                "Edit",
                row.original.paused ? "Resume" : "Pause",
                "Copy snippet",
                "Delete",
              ].map((a) => (
                <DropdownMenuItem
                  key={a}
                  onClick={() => onAction(a, row.original.id)}
                >
                  {a}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [onAction],
  );
  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 10 } },
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Filter tasks"
          className="max-w-xs"
          placeholder="Filter tasks…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            table.setPageIndex(0);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              "All",
              "Healthy",
              "Failing",
              "Missed",
              "Paused",
              "Deliverable missing",
            ].map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="ml-auto" onClick={onNew}>
          <Plus />
          New task
        </Button>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((g) => (
              <TableRow key={g.id}>
                {g.headers.map((h) => (
                  <TableHead key={h.id}>
                    {h.isPlaceholder ? null : h.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <ArrowUpDown className="size-3" />
                      </Button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((r) => (
              <TableRow key={r.id}>
                {r.getVisibleCells().map((c) => (
                  <TableCell key={c.id}>
                    {flexRender(
                      c.column.columnDef.cell ??
                        (({ getValue }) => String(getValue() ?? "")),
                      c.getContext(),
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!table.getRowModel().rows.length && (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center">
                  {tasks.length ? "No matching tasks." : "No tasks yet."}{" "}
                  <Button variant="link" onClick={onNew}>
                    Create a task
                  </Button>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {table.getFilteredRowModel().rows.length} tasks · Page{" "}
          {table.getState().pagination.pageIndex + 1} of{" "}
          {Math.max(1, table.getPageCount())}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
