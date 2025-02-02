/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {
  styled,
  produce,
  Toolbar,
  Select,
  FlexColumn,
  FlexRow,
  ManagedTable,
  Text,
  Button,
  ButtonGroup,
  Input,
  colors,
  getStringFromErrorLike,
  Spacer,
  Textarea,
  TableBodyColumn,
  TableRows,
  TableBodyRow,
  TableRowSortOrder,
  Value,
  renderValue,
} from 'flipper';
import React, {KeyboardEvent, ChangeEvent, useState, useCallback} from 'react';
import {Methods, Events} from './ClientProtocol';
import ButtonNavigation from './ButtonNavigation';
import DatabaseDetailSidebar from './DatabaseDetailSidebar';
import DatabaseStructure from './DatabaseStructure';
import {
  convertStringToValue,
  constructUpdateQuery,
  isUpdatable,
} from './UpdateQueryUtil';
import sqlFormatter from 'sql-formatter';
import dateFormat from 'dateformat';
import {createState, PluginClient, usePlugin, useValue} from 'flipper-plugin';

const PAGE_SIZE = 50;

const BoldSpan = styled.span({
  fontSize: 12,
  color: '#90949c',
  fontWeight: 'bold',
  textTransform: 'uppercase',
});
const ErrorBar = styled.div({
  backgroundColor: colors.cherry,
  color: colors.white,
  lineHeight: '26px',
  textAlign: 'center',
});
const QueryHistoryManagedTable = styled(ManagedTable)({paddingLeft: 16});
const PageInfoContainer = styled(FlexRow)({alignItems: 'center'});
const TableInfoTextArea = styled(Textarea)({
  width: '98%',
  height: '100%',
  marginLeft: '1%',
  marginTop: '1%',
  marginBottom: '1%',
  readOnly: true,
});

type DatabasesPluginState = {
  selectedDatabase: number;
  selectedDatabaseTable: string | null;
  pageRowNumber: number;
  databases: Array<DatabaseEntry>;
  outdatedDatabaseList: boolean;
  viewMode: 'data' | 'structure' | 'SQL' | 'tableInfo' | 'queryHistory';
  error: null;
  currentPage: Page | null;
  currentStructure: Structure | null;
  currentSort: TableRowSortOrder | null;
  query: Query | null;
  queryResult: QueryResult | null;
  favorites: Array<string>;
  executionTime: number;
  tableInfo: string;
  queryHistory: Array<Query>;
};

type Page = {
  databaseId: number;
  table: string;
  columns: Array<string>;
  rows: Array<Array<Value>>;
  start: number;
  count: number;
  total: number;
  highlightedRows: Array<number>;
};

export type Structure = {
  databaseId: number;
  table: string;
  columns: Array<string>;
  rows: Array<Array<Value>>;
  indexesColumns: Array<string>;
  indexesValues: Array<Array<Value>>;
};

type QueryResult = {
  table: QueriedTable | null;
  id: number | null;
  count: number | null;
};

export type QueriedTable = {
  columns: Array<string>;
  rows: Array<Array<Value>>;
  highlightedRows: Array<number>;
};

type DatabaseEntry = {
  id: number;
  name: string;
  tables: Array<string>;
};

type Query = {
  value: string;
  time: string;
};

function transformRow(
  columns: Array<string>,
  row: Array<Value>,
  index: number,
): TableBodyRow {
  const transformedColumns: {[key: string]: TableBodyColumn} = {};
  for (let i = 0; i < columns.length; i++) {
    transformedColumns[columns[i]] = {value: renderValue(row[i], true)};
  }
  return {key: String(index), columns: transformedColumns};
}

function renderQueryHistory(history: Array<Query>) {
  if (!history || typeof history === 'undefined') {
    return null;
  }
  const columns = {
    time: {
      value: 'Time',
      resizable: true,
    },
    query: {
      value: 'Query',
      resizable: true,
    },
  };
  const rows: TableRows = [];
  if (history.length > 0) {
    for (const query of history) {
      const time = query.time;
      const value = query.value;
      rows.push({
        key: value,
        columns: {time: {value: time}, query: {value: value}},
      });
    }
  }

  return (
    <FlexRow grow={true}>
      <QueryHistoryManagedTable
        floating={false}
        columns={columns}
        columnSizes={{time: 75}}
        zebra={true}
        rows={rows}
        horizontallyScrollable={true}
      />
    </FlexRow>
  );
}

type PageInfoProps = {
  currentRow: number;
  count: number;
  totalRows: number;
  onChange: (currentRow: number, count: number) => void;
};

function PageInfo(props: PageInfoProps) {
  const [state, setState] = useState({
    isOpen: false,
    inputValue: String(props.currentRow),
  });

  const onOpen = () => {
    setState({...state, isOpen: true});
  };

  const onInputChanged = (e: ChangeEvent<any>) => {
    setState({...state, inputValue: e.target.value});
  };

  const onSubmit = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const rowNumber = parseInt(state.inputValue, 10);
      props.onChange(rowNumber - 1, props.count);
      setState({...state, isOpen: false});
    }
  };

  return (
    <PageInfoContainer grow={true}>
      <div style={{flex: 1}} />
      <Text>
        {props.count === props.totalRows
          ? `${props.count} `
          : `${props.currentRow + 1}-${props.currentRow + props.count} `}
        of {props.totalRows} rows
      </Text>
      <div style={{flex: 1}} />
      {state.isOpen ? (
        <Input
          tabIndex={-1}
          placeholder={(props.currentRow + 1).toString()}
          onChange={onInputChanged}
          onKeyDown={onSubmit}
        />
      ) : (
        <Button style={{textAlign: 'center'}} onClick={onOpen}>
          Go To Row
        </Button>
      )}
    </PageInfoContainer>
  );
}

export function plugin(client: PluginClient<Events, Methods>) {
  const pluginState = createState<DatabasesPluginState>({
    selectedDatabase: 0,
    selectedDatabaseTable: null,
    pageRowNumber: 0,
    databases: [],
    outdatedDatabaseList: true,
    viewMode: 'data',
    error: null,
    currentPage: null,
    currentStructure: null,
    currentSort: null,
    query: null,
    queryResult: null,
    favorites: [],
    executionTime: 0,
    tableInfo: '',
    queryHistory: [],
  });

  const updateDatabases = (event: {
    databases: Array<{name: string; id: number; tables: Array<string>}>;
  }) => {
    const updates = event.databases;
    const state = pluginState.get();
    const databases = updates.sort((db1, db2) => db1.id - db2.id);
    const selectedDatabase =
      state.selectedDatabase ||
      (Object.values(databases)[0] ? Object.values(databases)[0].id : 0);
    const selectedTable =
      state.selectedDatabaseTable &&
      databases[selectedDatabase - 1].tables.includes(
        state.selectedDatabaseTable,
      )
        ? state.selectedDatabaseTable
        : databases[selectedDatabase - 1].tables[0];
    const sameTableSelected =
      selectedDatabase === state.selectedDatabase &&
      selectedTable === state.selectedDatabaseTable;
    pluginState.set({
      ...state,
      databases,
      outdatedDatabaseList: false,
      selectedDatabase: selectedDatabase,
      selectedDatabaseTable: selectedTable,
      pageRowNumber: 0,
      currentPage: sameTableSelected ? state.currentPage : null,
      currentStructure: null,
      currentSort: sameTableSelected ? state.currentSort : null,
    });
  };

  const updateSelectedDatabase = (event: {database: number}) => {
    const state = pluginState.get();
    pluginState.set({
      ...state,
      selectedDatabase: event.database,
      selectedDatabaseTable:
        state.databases[event.database - 1].tables[0] || null,
      pageRowNumber: 0,
      currentPage: null,
      currentStructure: null,
      currentSort: null,
    });
  };

  const updateSelectedDatabaseTable = (event: {table: string}) => {
    const state = pluginState.get();
    pluginState.set({
      ...state,
      selectedDatabaseTable: event.table,
      pageRowNumber: 0,
      currentPage: null,
      currentStructure: null,
      currentSort: null,
    });
  };

  const updateViewMode = (event: {
    viewMode: 'data' | 'structure' | 'SQL' | 'tableInfo' | 'queryHistory';
  }) => {
    pluginState.update((state) => {
      state.viewMode = event.viewMode;
      state.error = null;
    });
  };

  const updatePage = (event: Page) => {
    pluginState.update((state) => {
      state.currentPage = event;
    });
  };

  const updateStructure = (event: {
    databaseId: number;
    table: string;
    columns: Array<string>;
    rows: Array<Array<Value>>;
    indexesColumns: Array<string>;
    indexesValues: Array<Array<Value>>;
  }) => {
    pluginState.update((state) => {
      state.currentStructure = {
        databaseId: event.databaseId,
        table: event.table,
        columns: event.columns,
        rows: event.rows,
        indexesColumns: event.indexesColumns,
        indexesValues: event.indexesValues,
      };
    });
  };

  const displaySelect = (event: {
    columns: Array<string>;
    values: Array<Array<Value>>;
  }) => {
    pluginState.update((state) => {
      state.queryResult = {
        table: {
          columns: event.columns,
          rows: event.values,
          highlightedRows: [],
        },
        id: null,
        count: null,
      };
    });
  };

  const displayInsert = (event: {id: number}) => {
    const state = pluginState.get();
    pluginState.set({
      ...state,
      queryResult: {
        table: null,
        id: event.id,
        count: null,
      },
    });
  };

  const displayUpdateDelete = (event: {count: number}) => {
    pluginState.update((state) => {
      state.queryResult = {
        table: null,
        id: null,
        count: event.count,
      };
    });
  };

  const updateTableInfo = (event: {tableInfo: string}) => {
    pluginState.update((state) => {
      state.tableInfo = event.tableInfo;
    });
  };

  const nextPage = () => {
    pluginState.update((state) => {
      state.pageRowNumber += PAGE_SIZE;
      state.currentPage = null;
    });
  };

  const previousPage = () => {
    pluginState.update((state) => {
      state.pageRowNumber = Math.max(state.pageRowNumber - PAGE_SIZE, 0);
      state.currentPage = null;
    });
  };

  const execute = (event: {query: string}) => {
    const timeBefore = Date.now();
    const {query} = event;
    client
      .send('execute', {
        databaseId: pluginState.get().selectedDatabase,
        value: query,
      })
      .then((data) => {
        pluginState.update((state) => {
          state.error = null;
          state.executionTime = Date.now() - timeBefore;
        });
        if (data.type === 'select') {
          displaySelect({
            columns: data.columns,
            values: data.values,
          });
        } else if (data.type === 'insert') {
          displayInsert({
            id: data.insertedId,
          });
        } else if (data.type === 'update_delete') {
          displayUpdateDelete({
            count: data.affectedCount,
          });
        }
      })
      .catch((e) => {
        pluginState.update((state) => {
          state.error = e;
        });
      });
    let newHistory = pluginState.get().queryHistory;
    const newQuery = pluginState.get().query;
    if (
      newQuery !== null &&
      typeof newQuery !== 'undefined' &&
      newHistory !== null &&
      typeof newHistory !== 'undefined'
    ) {
      newQuery.time = dateFormat(new Date(), 'hh:MM:ss');
      newHistory = newHistory.concat(newQuery);
    }
    pluginState.update((state) => {
      state.queryHistory = newHistory;
    });
  };

  const goToRow = (event: {row: number}) => {
    const state = pluginState.get();
    if (!state.currentPage) {
      return;
    }
    const destinationRow =
      event.row < 0
        ? 0
        : event.row >= state.currentPage.total - PAGE_SIZE
        ? Math.max(state.currentPage.total - PAGE_SIZE, 0)
        : event.row;
    pluginState.update((state) => {
      state.pageRowNumber = destinationRow;
      state.currentPage = null;
    });
  };

  const refresh = () => {
    pluginState.update((state) => {
      state.outdatedDatabaseList = true;
      state.currentPage = null;
    });
  };

  const updateFavorites = (event: {favorites: Array<string> | undefined}) => {
    const state = pluginState.get();
    let newFavorites = event.favorites || state.favorites;
    if (
      state.query &&
      state.query !== null &&
      typeof state.query !== 'undefined'
    ) {
      const value = state.query.value;
      if (newFavorites.includes(value)) {
        const index = newFavorites.indexOf(value);
        newFavorites.splice(index, 1);
      } else {
        newFavorites = state.favorites.concat(value);
      }
    }
    window.localStorage.setItem(
      'plugin-database-favorites-sql-queries',
      JSON.stringify(newFavorites),
    );
    return {
      ...state,
      favorites: newFavorites,
    };
  };

  const sortByChanged = (event: {sortOrder: TableRowSortOrder}) => {
    const state = pluginState.get();
    pluginState.set({
      ...state,
      currentSort: event.sortOrder,
      pageRowNumber: 0,
      currentPage: null,
    });
  };

  const updateQuery = (event: {value: string}) => {
    const state = pluginState.get();
    pluginState.set({
      ...state,
      query: {
        value: event.value,
        time: dateFormat(new Date(), 'hh:MM:ss'),
      },
    });
  };

  pluginState.subscribe(
    (newState: DatabasesPluginState, previousState: DatabasesPluginState) => {
      const databaseId = newState.selectedDatabase;
      const table = newState.selectedDatabaseTable;
      if (
        newState.viewMode === 'data' &&
        newState.currentPage === null &&
        databaseId &&
        table
      ) {
        client
          .send('getTableData', {
            count: PAGE_SIZE,
            databaseId: newState.selectedDatabase,
            order: newState.currentSort?.key,
            reverse: (newState.currentSort?.direction || 'up') === 'down',
            table: table,
            start: newState.pageRowNumber,
          })
          .then((data) => {
            updatePage({
              databaseId: databaseId,
              table: table,
              columns: data.columns,
              rows: data.values,
              start: data.start,
              count: data.count,
              total: data.total,
              highlightedRows: [],
            });
          })
          .catch((e) => {
            pluginState.update((state) => {
              state.error = e;
            });
          });
      }
      if (newState.currentStructure === null && databaseId && table) {
        client
          .send('getTableStructure', {
            databaseId: databaseId,
            table: table,
          })
          .then((data) => {
            updateStructure({
              databaseId: databaseId,
              table: table,
              columns: data.structureColumns,
              rows: data.structureValues,
              indexesColumns: data.indexesColumns,
              indexesValues: data.indexesValues,
            });
          })
          .catch((e) => {
            pluginState.update((state) => {
              state.error = e;
            });
          });
      }
      if (
        newState.viewMode === 'tableInfo' &&
        newState.currentStructure === null &&
        databaseId &&
        table
      ) {
        client
          .send('getTableInfo', {
            databaseId: databaseId,
            table: table,
          })
          .then((data) => {
            updateTableInfo({
              tableInfo: data.definition,
            });
          })
          .catch((e) => {
            pluginState.update((state) => {
              state.error = e;
            });
          });
      }

      if (
        !previousState.outdatedDatabaseList &&
        newState.outdatedDatabaseList
      ) {
        client.send('databaseList', {}).then((databases) => {
          updateDatabases({
            databases,
          });
        });
      }
    },
  );

  client.onConnect(() => {
    client.send('databaseList', {}).then((databases) => {
      updateDatabases({
        databases,
      });
    });
    updateFavorites({
      favorites: JSON.parse(
        localStorage.getItem('plugin-database-favorites-sql-queries') || '[]',
      ),
    });
  });

  return {
    state: pluginState,
    updateDatabases,
    updateSelectedDatabase,
    updateSelectedDatabaseTable,
    updateViewMode,
    updatePage,
    updateStructure,
    displaySelect,
    displayInsert,
    displayUpdateDelete,
    updateTableInfo,
    nextPage,
    previousPage,
    execute,
    goToRow,
    refresh,
    updateFavorites,
    sortByChanged,
    updateQuery,
  };
}

export function Component() {
  const instance = usePlugin(plugin);
  const state = useValue(instance.state);

  const onDataClicked = useCallback(() => {
    instance.updateViewMode({viewMode: 'data'});
  }, [instance]);

  const onStructureClicked = useCallback(() => {
    instance.updateViewMode({viewMode: 'structure'});
  }, [instance]);

  const onSQLClicked = useCallback(() => {
    instance.updateViewMode({viewMode: 'SQL'});
  }, [instance]);

  const onTableInfoClicked = useCallback(() => {
    instance.updateViewMode({viewMode: 'tableInfo'});
  }, [instance]);

  const onQueryHistoryClicked = useCallback(() => {
    instance.updateViewMode({viewMode: 'queryHistory'});
  }, [instance]);

  const onRefreshClicked = useCallback(() => {
    instance.state.update((state) => {
      state.error = null;
    });
    instance.refresh();
  }, [instance]);

  const onFavoritesClicked = useCallback(() => {
    instance.updateFavorites({
      favorites: instance.state.get().favorites,
    });
  }, [instance]);

  const onDatabaseSelected = useCallback(
    (selected: string) => {
      const dbId =
        instance.state.get().databases.find((x) => x.name === selected)?.id ||
        0;
      instance.updateSelectedDatabase({
        database: dbId,
      });
    },
    [instance],
  );

  const onDatabaseTableSelected = useCallback(
    (selected: string) => {
      instance.updateSelectedDatabaseTable({
        table: selected,
      });
    },
    [instance],
  );

  const onNextPageClicked = useCallback(() => {
    instance.nextPage();
  }, [instance]);

  const onPreviousPageClicked = useCallback(() => {
    instance.previousPage();
  }, [instance]);

  const onExecuteClicked = useCallback(() => {
    const query = instance.state.get().query;
    if (query) {
      instance.execute({query: query.value});
    }
  }, [instance]);

  const onQueryTextareaKeyPress = useCallback(
    (event: KeyboardEvent) => {
      // Implement ctrl+enter as a shortcut for clicking 'Execute'.
      if (event.key === '\n' && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        onExecuteClicked();
      }
    },
    [onExecuteClicked],
  );

  const onGoToRow = useCallback(
    (row: number, _count: number) => {
      instance.goToRow({row: row});
    },
    [instance],
  );

  const onQueryChanged = useCallback(
    (selected: any) => {
      instance.updateQuery({
        value: selected.target.value,
      });
    },
    [instance],
  );

  const onRowEdited = useCallback(
    (change: {[key: string]: string | null}) => {
      const {
        selectedDatabaseTable,
        currentStructure,
        viewMode,
        currentPage,
      } = instance.state.get();
      const highlightedRowIdx = currentPage?.highlightedRows[0] ?? -1;
      const row =
        highlightedRowIdx >= 0
          ? currentPage?.rows[currentPage?.highlightedRows[0]]
          : undefined;
      const columns = currentPage?.columns;
      // currently only allow to edit data shown in Data tab
      if (
        viewMode !== 'data' ||
        selectedDatabaseTable === null ||
        currentStructure === null ||
        currentPage === null ||
        row === undefined ||
        columns === undefined ||
        // only trigger when there is change
        Object.keys(change).length <= 0
      ) {
        return;
      }
      // check if the table has primary key to use for query
      // This is assumed data are in the same format as in SqliteDatabaseDriver.java
      const primaryKeyIdx = currentStructure.columns.indexOf('primary_key');
      const nameKeyIdx = currentStructure.columns.indexOf('column_name');
      const typeIdx = currentStructure.columns.indexOf('data_type');
      const nullableIdx = currentStructure.columns.indexOf('nullable');
      if (primaryKeyIdx < 0 && nameKeyIdx < 0 && typeIdx < 0) {
        console.error(
          'primary_key, column_name, and/or data_type cannot be empty',
        );
        return;
      }
      const primaryColumnIndexes = currentStructure.rows
        .reduce((acc, row) => {
          const primary = row[primaryKeyIdx];
          if (primary.type === 'boolean' && primary.value) {
            const name = row[nameKeyIdx];
            return name.type === 'string' ? acc.concat(name.value) : acc;
          } else {
            return acc;
          }
        }, [] as Array<string>)
        .map((name) => columns.indexOf(name))
        .filter((idx) => idx >= 0);
      // stop if no primary key to distinguish unique query
      if (primaryColumnIndexes.length <= 0) {
        return;
      }

      const types = currentStructure.rows.reduce((acc, row) => {
        const nameValue = row[nameKeyIdx];
        const name = nameValue.type === 'string' ? nameValue.value : null;
        const typeValue = row[typeIdx];
        const type = typeValue.type === 'string' ? typeValue.value : null;
        const nullableValue =
          nullableIdx < 0 ? {type: 'null', value: null} : row[nullableIdx];
        const nullable = nullableValue.value !== false;
        if (name !== null && type !== null) {
          acc[name] = {type, nullable};
        }
        return acc;
      }, {} as {[key: string]: {type: string; nullable: boolean}});

      const changeValue = Object.entries(change).reduce(
        (acc, [key, value]: [string, string | null]) => {
          acc[key] = convertStringToValue(types, key, value);
          return acc;
        },
        {} as {[key: string]: Value},
      );
      instance.execute({
        query: constructUpdateQuery(
          selectedDatabaseTable,
          primaryColumnIndexes.reduce((acc, idx) => {
            acc[columns[idx]] = row[idx];
            return acc;
          }, {} as {[key: string]: Value}),
          changeValue,
        ),
      });
      instance.updatePage({
        ...produce(currentPage, (draft) =>
          Object.entries(changeValue).forEach(
            ([key, value]: [string, Value]) => {
              const columnIdx = draft.columns.indexOf(key);
              if (columnIdx >= 0) {
                draft.rows[highlightedRowIdx][columnIdx] = value;
              }
            },
          ),
        ),
      });
    },
    [instance],
  );

  const renderTable = (page: Page | null) => {
    if (!page) {
      return null;
    }
    return (
      <FlexRow grow={true}>
        <ManagedTable
          tableKey={`databases-${page.databaseId}-${page.table}`}
          floating={false}
          columnOrder={page.columns.map((name) => ({
            key: name,
            visible: true,
          }))}
          columns={page.columns.reduce(
            (acc, val) =>
              Object.assign({}, acc, {
                [val]: {value: val, resizable: true, sortable: true},
              }),
            {},
          )}
          zebra={true}
          rows={page.rows.map((row: Array<Value>, index: number) =>
            transformRow(page.columns, row, index),
          )}
          horizontallyScrollable={true}
          multiHighlight={true}
          onRowHighlighted={(highlightedRows) =>
            instance.state.update((draftState: DatabasesPluginState) => {
              if (draftState.currentPage !== null) {
                draftState.currentPage.highlightedRows = highlightedRows.map(
                  parseInt,
                );
              }
            })
          }
          onSort={(sortOrder: TableRowSortOrder) => {
            instance.sortByChanged({
              sortOrder,
            });
          }}
          initialSortOrder={state.currentSort ?? undefined}
        />
        {page.highlightedRows.length === 1 && (
          <DatabaseDetailSidebar
            columnLabels={page.columns}
            columnValues={page.rows[page.highlightedRows[0]]}
            onSave={
              state.currentStructure &&
              isUpdatable(
                state.currentStructure.columns,
                state.currentStructure.rows,
              )
                ? onRowEdited
                : undefined
            }
          />
        )}
      </FlexRow>
    );
  };

  const renderQuery = (query: QueryResult | null) => {
    if (!query || query === null) {
      return null;
    }
    if (
      query.table &&
      typeof query.table !== 'undefined' &&
      query.table !== null
    ) {
      const table = query.table;
      const columns = table.columns;
      const rows = table.rows;
      return (
        <FlexRow grow={true} style={{paddingTop: 18}}>
          <ManagedTable
            floating={false}
            multiline={true}
            columnOrder={columns.map((name) => ({
              key: name,
              visible: true,
            }))}
            columns={columns.reduce(
              (acc, val) =>
                Object.assign({}, acc, {[val]: {value: val, resizable: true}}),
              {},
            )}
            zebra={true}
            rows={rows.map((row: Array<Value>, index: number) =>
              transformRow(columns, row, index),
            )}
            horizontallyScrollable={true}
            onRowHighlighted={(highlightedRows) => {
              instance.state.set({
                ...instance.state.get(),
                queryResult: {
                  table: {
                    columns: columns,
                    rows: rows,
                    highlightedRows: highlightedRows.map(parseInt),
                  },
                  id: null,
                  count: null,
                },
              });
            }}
          />
          {table.highlightedRows.length === 1 && (
            <DatabaseDetailSidebar
              columnLabels={table.columns}
              columnValues={table.rows[table.highlightedRows[0]]}
            />
          )}
        </FlexRow>
      );
    } else if (query.id && query.id !== null) {
      return (
        <FlexRow grow={true} style={{paddingTop: 18}}>
          <Text style={{paddingTop: 8, paddingLeft: 8}}>
            Row id: {query.id}
          </Text>
        </FlexRow>
      );
    } else if (query.count && query.count !== null) {
      return (
        <FlexRow grow={true} style={{paddingTop: 18}}>
          <Text style={{paddingTop: 8, paddingLeft: 8}}>
            Rows affected: {query.count}
          </Text>
        </FlexRow>
      );
    } else {
      return null;
    }
  };

  const tableOptions =
    (state.selectedDatabase &&
      state.databases[state.selectedDatabase - 1] &&
      state.databases[state.selectedDatabase - 1].tables.reduce(
        (options, tableName) => ({...options, [tableName]: tableName}),
        {},
      )) ||
    {};

  return (
    <FlexColumn style={{flex: 1}}>
      <Toolbar position="top" style={{paddingLeft: 16}}>
        <ButtonGroup>
          <Button
            icon={'data-table'}
            onClick={onDataClicked}
            selected={state.viewMode === 'data'}>
            Data
          </Button>
          <Button
            icon={'gears-two'}
            onClick={onStructureClicked}
            selected={state.viewMode === 'structure'}>
            Structure
          </Button>
          <Button
            icon={'magnifying-glass'}
            onClick={onSQLClicked}
            selected={state.viewMode === 'SQL'}>
            SQL
          </Button>
          <Button
            icon={'info-cursive'}
            onClick={onTableInfoClicked}
            selected={state.viewMode === 'tableInfo'}>
            Table Info
          </Button>
          <Button
            icon={'on-this-day'}
            iconSize={12}
            onClick={onQueryHistoryClicked}
            selected={state.viewMode === 'queryHistory'}>
            Query History
          </Button>
        </ButtonGroup>
      </Toolbar>
      {state.viewMode === 'data' ||
      state.viewMode === 'structure' ||
      state.viewMode === 'tableInfo' ? (
        <Toolbar position="top" style={{paddingLeft: 16}}>
          <BoldSpan style={{marginRight: 16}}>Database</BoldSpan>
          <Select
            options={state.databases
              .map((x) => x.name)
              .reduce(
                (obj, item) => Object.assign({}, obj, {[item]: item}),
                {},
              )}
            selected={state.databases[state.selectedDatabase - 1]?.name}
            onChange={onDatabaseSelected}
            style={{maxWidth: 300}}
          />
          <BoldSpan style={{marginLeft: 16, marginRight: 16}}>Table</BoldSpan>
          <Select
            options={tableOptions}
            selected={state.selectedDatabaseTable}
            onChange={onDatabaseTableSelected}
            style={{maxWidth: 300}}
          />
          <div />
          <Button onClick={onRefreshClicked}>Refresh</Button>
        </Toolbar>
      ) : null}
      {state.viewMode === 'SQL' ? (
        <div>
          <Toolbar position="top" style={{paddingLeft: 16}}>
            <BoldSpan style={{marginRight: 16}}>Database</BoldSpan>
            <Select
              options={state.databases
                .map((x) => x.name)
                .reduce(
                  (obj, item) => Object.assign({}, obj, {[item]: item}),
                  {},
                )}
              selected={state.databases[state.selectedDatabase - 1]?.name}
              onChange={onDatabaseSelected}
            />
          </Toolbar>
          {
            <Textarea
              style={{
                width: '98%',
                height: '40%',
                marginLeft: 16,
                marginTop: '1%',
                marginBottom: '1%',
                resize: 'vertical',
              }}
              onChange={onQueryChanged}
              onKeyPress={onQueryTextareaKeyPress}
              placeholder="Type query here.."
              value={
                state.query !== null && typeof state.query !== 'undefined'
                  ? state.query.value
                  : undefined
              }
            />
          }
          <Toolbar
            position="top"
            style={{paddingLeft: 16, paddingTop: 24, paddingBottom: 24}}>
            <ButtonGroup>
              <Button
                icon={'star'}
                iconSize={12}
                iconVariant={
                  state.query !== null &&
                  typeof state.query !== 'undefined' &&
                  state.favorites.includes(state.query.value)
                    ? 'filled'
                    : 'outline'
                }
                onClick={onFavoritesClicked}
              />
              {state.favorites !== null ? (
                <Button
                  dropdown={state.favorites.map((option) => {
                    return {
                      click: () => {
                        instance.state.set({
                          ...instance.state.get(),
                          query: {
                            value: option,
                            time: dateFormat(new Date(), 'hh:MM:ss'),
                          },
                        });
                        onQueryChanged;
                      },
                      label: option,
                    };
                  })}>
                  Choose from previous queries
                </Button>
              ) : null}
            </ButtonGroup>
            <Spacer />
            <ButtonGroup>
              <Button
                onClick={onExecuteClicked}
                title={'Execute SQL [Ctrl+Return]'}>
                Execute
              </Button>
            </ButtonGroup>
          </Toolbar>
        </div>
      ) : null}
      <FlexRow grow={true}>
        <FlexColumn grow={true}>
          {state.viewMode === 'data' ? renderTable(state.currentPage) : null}
          {state.viewMode === 'structure' ? (
            <DatabaseStructure structure={state.currentStructure} />
          ) : null}
          {state.viewMode === 'SQL' ? renderQuery(state.queryResult) : null}
          {state.viewMode === 'tableInfo' ? (
            <TableInfoTextArea
              value={sqlFormatter.format(state.tableInfo)}
              readOnly
            />
          ) : null}
          {state.viewMode === 'queryHistory'
            ? renderQueryHistory(state.queryHistory)
            : null}
        </FlexColumn>
      </FlexRow>
      <Toolbar position="bottom" style={{paddingLeft: 8}}>
        <FlexRow grow={true}>
          {state.viewMode === 'SQL' && state.executionTime !== 0 ? (
            <Text> {state.executionTime} ms </Text>
          ) : null}
          {state.viewMode === 'data' && state.currentPage ? (
            <PageInfo
              currentRow={state.currentPage.start}
              count={state.currentPage.count}
              totalRows={state.currentPage.total}
              onChange={onGoToRow}
            />
          ) : null}
          {state.viewMode === 'data' && state.currentPage ? (
            <ButtonNavigation
              canGoBack={state.currentPage.start > 0}
              canGoForward={
                state.currentPage.start + state.currentPage.count <
                state.currentPage.total
              }
              onBack={onPreviousPageClicked}
              onForward={onNextPageClicked}
            />
          ) : null}
        </FlexRow>
      </Toolbar>
      {state.error && (
        <ErrorBar>{getStringFromErrorLike(state.error)}</ErrorBar>
      )}
    </FlexColumn>
  );
}
