const BLOCK_TYPES = new Set([
	"header",
	"section",
	"divider",
	"fields",
	"table",
	"actions",
	"stats",
	"form",
	"image",
	"context",
	"columns",
	"chart",
	"banner",
	"meter",
	"code",
	"empty",
	"accordion",
]);

const EMPTY_SIZES = new Set(["sm", "base", "lg"]);

const ELEMENT_TYPES = new Set([
	"button",
	"text_input",
	"number_input",
	"select",
	"toggle",
	"secret_input",
	"checkbox",
	"radio",
	"date_input",
	"combobox",
	"repeater",
	"media_picker",
]);

const REPEATER_SUB_FIELD_TYPES = new Set(["text_input", "number_input", "select", "toggle"]);

const COLUMN_FORMATS = new Set(["text", "badge", "relative_time", "number", "code"]);

const CODE_LANGUAGES = new Set(["ts", "tsx", "jsonc", "bash", "css"]);

const BUTTON_STYLES = new Set(["primary", "danger", "secondary"]);
const TREND_VALUES = new Set(["up", "down", "neutral"]);
const BANNER_VARIANTS = new Set(["default", "alert", "error"]);

/**
 * Validate option uniqueness and that initial_value references a valid option.
 * Used by select, radio, combobox, and checkbox element validation.
 */
function validateOptionValues(
	options: unknown[],
	path: string,
	errors: ValidationError[],
): Set<string> {
	const seen = new Set<string>();
	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		if (isRecord(opt) && typeof opt.value === "string") {
			if (seen.has(opt.value)) {
				errors.push({
					path: `${path}[${i}].value`,
					message: `Duplicate option value '${opt.value}'`,
				});
			}
			seen.add(opt.value);
		}
	}
	return seen;
}

function validateInitialValueInOptions(
	initialValue: unknown,
	validValues: Set<string>,
	path: string,
	errors: ValidationError[],
): void {
	if (typeof initialValue === "string" && validValues.size > 0 && !validValues.has(initialValue)) {
		errors.push({
			path: `${path}.initial_value`,
			message: `initial_value '${initialValue}' does not match any option value`,
		});
	}
}

interface ValidationError {
	path: string;
	message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateConfirmDialog(value: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ path, message: "Confirm dialog must be an object" });
		return;
	}
	if (typeof value.title !== "string") {
		errors.push({
			path: `${path}.title`,
			message: "Required field 'title' must be a string",
		});
	}
	if (typeof value.text !== "string") {
		errors.push({
			path: `${path}.text`,
			message: "Required field 'text' must be a string",
		});
	}
	if (typeof value.confirm !== "string") {
		errors.push({
			path: `${path}.confirm`,
			message: "Required field 'confirm' must be a string",
		});
	}
	if (typeof value.deny !== "string") {
		errors.push({
			path: `${path}.deny`,
			message: "Required field 'deny' must be a string",
		});
	}
	if (value.style !== undefined && value.style !== "danger") {
		errors.push({
			path: `${path}.style`,
			message: "Field 'style' must be \"danger\" if provided",
		});
	}
}

function validateElement(value: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ path, message: "Element must be an object" });
		return;
	}

	const type = value.type;
	if (typeof type !== "string" || !ELEMENT_TYPES.has(type)) {
		errors.push({
			path: `${path}.type`,
			message: `Unknown element type '${String(type)}'. Expected one of: ${[...ELEMENT_TYPES].join(", ")}`,
		});
		return;
	}

	if (typeof value.action_id !== "string") {
		errors.push({
			path: `${path}.action_id`,
			message: "Required field 'action_id' must be a string",
		});
	}
	if (typeof value.label !== "string") {
		errors.push({
			path: `${path}.label`,
			message: "Required field 'label' must be a string",
		});
	}

	switch (type) {
		case "button": {
			if (
				value.style !== undefined &&
				(typeof value.style !== "string" || !BUTTON_STYLES.has(value.style))
			) {
				errors.push({
					path: `${path}.style`,
					message: `Field 'style' must be one of: ${[...BUTTON_STYLES].join(", ")}`,
				});
			}
			if (value.confirm !== undefined) {
				validateConfirmDialog(value.confirm, `${path}.confirm`, errors);
			}
			break;
		}
		case "text_input": {
			if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
				errors.push({
					path: `${path}.placeholder`,
					message: "Field 'placeholder' must be a string",
				});
			}
			if (value.initial_value !== undefined && typeof value.initial_value !== "string") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a string",
				});
			}
			if (value.multiline !== undefined && typeof value.multiline !== "boolean") {
				errors.push({
					path: `${path}.multiline`,
					message: "Field 'multiline' must be a boolean",
				});
			}
			break;
		}
		case "number_input": {
			if (value.initial_value !== undefined && typeof value.initial_value !== "number") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a number",
				});
			}
			if (value.min !== undefined && typeof value.min !== "number") {
				errors.push({
					path: `${path}.min`,
					message: "Field 'min' must be a number",
				});
			}
			if (value.max !== undefined && typeof value.max !== "number") {
				errors.push({
					path: `${path}.max`,
					message: "Field 'max' must be a number",
				});
			}
			break;
		}
		case "select": {
			let selectValidValues = new Set<string>();
			if (!Array.isArray(value.options)) {
				errors.push({
					path: `${path}.options`,
					message: "Required field 'options' must be an array",
				});
			} else if (value.options.length === 0) {
				errors.push({
					path: `${path}.options`,
					message: "Field 'options' must not be empty",
				});
			} else {
				for (let i = 0; i < value.options.length; i++) {
					const opt = value.options[i] as unknown;
					if (!isRecord(opt)) {
						errors.push({
							path: `${path}.options[${i}]`,
							message: "Option must be an object",
						});
						continue;
					}
					if (typeof opt.label !== "string") {
						errors.push({
							path: `${path}.options[${i}].label`,
							message: "Option 'label' must be a string",
						});
					}
					if (typeof opt.value !== "string") {
						errors.push({
							path: `${path}.options[${i}].value`,
							message: "Option 'value' must be a string",
						});
					}
				}
				selectValidValues = validateOptionValues(value.options, `${path}.options`, errors);
			}
			if (value.initial_value !== undefined && typeof value.initial_value !== "string") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a string",
				});
			}
			if (value.initial_value !== undefined) {
				validateInitialValueInOptions(value.initial_value, selectValidValues, path, errors);
			}
			break;
		}
		case "toggle": {
			if (value.description !== undefined && typeof value.description !== "string") {
				errors.push({
					path: `${path}.description`,
					message: "Field 'description' must be a string",
				});
			}
			if (value.initial_value !== undefined && typeof value.initial_value !== "boolean") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a boolean",
				});
			}
			break;
		}
		case "secret_input": {
			if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
				errors.push({
					path: `${path}.placeholder`,
					message: "Field 'placeholder' must be a string",
				});
			}
			if (value.has_value !== undefined && typeof value.has_value !== "boolean") {
				errors.push({
					path: `${path}.has_value`,
					message: "Field 'has_value' must be a boolean",
				});
			}
			break;
		}
		case "checkbox": {
			let checkboxValidValues = new Set<string>();
			if (!Array.isArray(value.options)) {
				errors.push({
					path: `${path}.options`,
					message: "Required field 'options' must be an array",
				});
			} else if (value.options.length === 0) {
				errors.push({ path: `${path}.options`, message: "Field 'options' must not be empty" });
			} else {
				for (let i = 0; i < value.options.length; i++) {
					const opt = value.options[i] as unknown;
					if (!isRecord(opt)) {
						errors.push({ path: `${path}.options[${i}]`, message: "Option must be an object" });
						continue;
					}
					if (typeof opt.label !== "string") {
						errors.push({
							path: `${path}.options[${i}].label`,
							message: "Option 'label' must be a string",
						});
					}
					if (typeof opt.value !== "string") {
						errors.push({
							path: `${path}.options[${i}].value`,
							message: "Option 'value' must be a string",
						});
					}
				}
				checkboxValidValues = validateOptionValues(value.options, `${path}.options`, errors);
			}
			if (value.initial_value !== undefined) {
				if (!Array.isArray(value.initial_value)) {
					errors.push({
						path: `${path}.initial_value`,
						message: "Field 'initial_value' must be an array of strings",
					});
				} else {
					for (let i = 0; i < value.initial_value.length; i++) {
						const item = value.initial_value[i];
						if (typeof item !== "string") {
							errors.push({
								path: `${path}.initial_value[${i}]`,
								message: "Each initial_value entry must be a string",
							});
							break;
						}
						if (checkboxValidValues.size > 0 && !checkboxValidValues.has(item)) {
							errors.push({
								path: `${path}.initial_value[${i}]`,
								message: `initial_value '${item}' does not match any option value`,
							});
						}
					}
				}
			}
			break;
		}
		case "radio": {
			let radioValidValues = new Set<string>();
			if (!Array.isArray(value.options)) {
				errors.push({
					path: `${path}.options`,
					message: "Required field 'options' must be an array",
				});
			} else if (value.options.length === 0) {
				errors.push({ path: `${path}.options`, message: "Field 'options' must not be empty" });
			} else {
				for (let i = 0; i < value.options.length; i++) {
					const opt = value.options[i] as unknown;
					if (!isRecord(opt)) {
						errors.push({ path: `${path}.options[${i}]`, message: "Option must be an object" });
						continue;
					}
					if (typeof opt.label !== "string") {
						errors.push({
							path: `${path}.options[${i}].label`,
							message: "Option 'label' must be a string",
						});
					}
					if (typeof opt.value !== "string") {
						errors.push({
							path: `${path}.options[${i}].value`,
							message: "Option 'value' must be a string",
						});
					}
				}
				radioValidValues = validateOptionValues(value.options, `${path}.options`, errors);
			}
			if (value.initial_value !== undefined && typeof value.initial_value !== "string") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a string",
				});
			}
			if (value.initial_value !== undefined) {
				validateInitialValueInOptions(value.initial_value, radioValidValues, path, errors);
			}
			break;
		}
		case "date_input": {
			if (value.initial_value !== undefined && typeof value.initial_value !== "string") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a string",
				});
			}
			if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
				errors.push({
					path: `${path}.placeholder`,
					message: "Field 'placeholder' must be a string",
				});
			}
			break;
		}
		case "combobox": {
			let comboboxValidValues = new Set<string>();
			if (!Array.isArray(value.options)) {
				errors.push({
					path: `${path}.options`,
					message: "Required field 'options' must be an array",
				});
			} else if (value.options.length === 0) {
				errors.push({ path: `${path}.options`, message: "Field 'options' must not be empty" });
			} else {
				for (let i = 0; i < value.options.length; i++) {
					const opt = value.options[i] as unknown;
					if (!isRecord(opt)) {
						errors.push({ path: `${path}.options[${i}]`, message: "Option must be an object" });
						continue;
					}
					if (typeof opt.label !== "string") {
						errors.push({
							path: `${path}.options[${i}].label`,
							message: "Option 'label' must be a string",
						});
					}
					if (typeof opt.value !== "string") {
						errors.push({
							path: `${path}.options[${i}].value`,
							message: "Option 'value' must be a string",
						});
					}
				}
				comboboxValidValues = validateOptionValues(value.options, `${path}.options`, errors);
			}
			if (value.initial_value !== undefined && typeof value.initial_value !== "string") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a string",
				});
			}
			if (value.initial_value !== undefined) {
				validateInitialValueInOptions(value.initial_value, comboboxValidValues, path, errors);
			}
			if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
				errors.push({
					path: `${path}.placeholder`,
					message: "Field 'placeholder' must be a string",
				});
			}
			break;
		}
		case "repeater": {
			if (!Array.isArray(value.fields)) {
				errors.push({
					path: `${path}.fields`,
					message: "Required field 'fields' must be an array",
				});
			} else if (value.fields.length === 0) {
				errors.push({
					path: `${path}.fields`,
					message: "Field 'fields' must not be empty",
				});
			} else {
				for (let i = 0; i < value.fields.length; i++) {
					const subPath = `${path}.fields[${i}]`;
					const sub = value.fields[i];
					if (
						isRecord(sub) &&
						typeof sub.type === "string" &&
						!REPEATER_SUB_FIELD_TYPES.has(sub.type)
					) {
						errors.push({
							path: `${subPath}.type`,
							message: `Repeater sub-field type '${sub.type}' is not allowed. Expected one of: ${[...REPEATER_SUB_FIELD_TYPES].join(", ")}`,
						});
						continue;
					}
					validateElement(sub, subPath, errors);
				}
			}
			if (value.item_label !== undefined && typeof value.item_label !== "string") {
				errors.push({
					path: `${path}.item_label`,
					message: "Field 'item_label' must be a string",
				});
			}
			const minOk =
				value.min_items === undefined ||
				(Number.isInteger(value.min_items) && (value.min_items as number) >= 0);
			if (!minOk) {
				errors.push({
					path: `${path}.min_items`,
					message: "Field 'min_items' must be a non-negative integer",
				});
			}
			const maxOk =
				value.max_items === undefined ||
				(Number.isInteger(value.max_items) && (value.max_items as number) >= 0);
			if (!maxOk) {
				errors.push({
					path: `${path}.max_items`,
					message: "Field 'max_items' must be a non-negative integer",
				});
			}
			if (
				minOk &&
				maxOk &&
				value.min_items !== undefined &&
				value.max_items !== undefined &&
				(value.min_items as number) > (value.max_items as number)
			) {
				errors.push({
					path: `${path}.min_items`,
					message: "Field 'min_items' must be less than or equal to 'max_items'",
				});
			}
			if (value.initial_value !== undefined) {
				if (!Array.isArray(value.initial_value)) {
					errors.push({
						path: `${path}.initial_value`,
						message: "Field 'initial_value' must be an array",
					});
				} else {
					for (let i = 0; i < value.initial_value.length; i++) {
						if (!isRecord(value.initial_value[i])) {
							errors.push({
								path: `${path}.initial_value[${i}]`,
								message: "Each initial_value entry must be an object",
							});
						}
					}
				}
			}
			break;
		}
		case "media_picker": {
			if (value.mime_type_filter !== undefined && typeof value.mime_type_filter !== "string") {
				errors.push({
					path: `${path}.mime_type_filter`,
					message: "Field 'mime_type_filter' must be a string",
				});
			}
			if (value.initial_value !== undefined && typeof value.initial_value !== "string") {
				errors.push({
					path: `${path}.initial_value`,
					message: "Field 'initial_value' must be a string",
				});
			}
			if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
				errors.push({
					path: `${path}.placeholder`,
					message: "Field 'placeholder' must be a string",
				});
			}
			break;
		}
	}
}

function validateFormField(value: unknown, path: string, errors: ValidationError[]): void {
	validateElement(value, path, errors);

	if (!isRecord(value)) return;

	if (value.condition !== undefined) {
		const cond = value.condition;
		if (!isRecord(cond)) {
			errors.push({
				path: `${path}.condition`,
				message: "Field 'condition' must be an object",
			});
		} else if (typeof cond.field !== "string") {
			errors.push({
				path: `${path}.condition.field`,
				message: "Condition 'field' must be a string",
			});
		} else if (!("eq" in cond) && !("neq" in cond)) {
			errors.push({
				path: `${path}.condition`,
				message: "Condition must have either 'eq' or 'neq'",
			});
		}
	}
}

const CHART_TYPES = new Set(["timeseries", "custom"]);
const CHART_STYLES = new Set(["line", "bar"]);

function validateChartSeries(value: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ path, message: "Chart series must be an object" });
		return;
	}
	if (typeof value.name !== "string") {
		errors.push({
			path: `${path}.name`,
			message: "Required field 'name' must be a string",
		});
	}
	if (!Array.isArray(value.data)) {
		errors.push({
			path: `${path}.data`,
			message: "Required field 'data' must be an array of [timestamp, value] tuples",
		});
	} else {
		for (let i = 0; i < value.data.length; i++) {
			const point = value.data[i] as unknown;
			if (
				!Array.isArray(point) ||
				point.length !== 2 ||
				typeof point[0] !== "number" ||
				typeof point[1] !== "number"
			) {
				errors.push({
					path: `${path}.data[${i}]`,
					message: "Each data point must be a [number, number] tuple",
				});
				break; // One error is enough for malformed data arrays
			}
		}
	}
	if (value.color !== undefined && typeof value.color !== "string") {
		errors.push({
			path: `${path}.color`,
			message: "Field 'color' must be a string if provided",
		});
	}
}

function validateChartConfig(value: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ path, message: "Required field 'config' must be an object" });
		return;
	}

	const chartType = value.chart_type;
	if (typeof chartType !== "string" || !CHART_TYPES.has(chartType)) {
		errors.push({
			path: `${path}.chart_type`,
			message: `Field 'chart_type' must be one of: ${[...CHART_TYPES].join(", ")}`,
		});
		return;
	}

	if (value.height !== undefined) {
		if (typeof value.height !== "number") {
			errors.push({
				path: `${path}.height`,
				message: "Field 'height' must be a number if provided",
			});
		} else if (value.height <= 0) {
			errors.push({
				path: `${path}.height`,
				message: "Field 'height' must be a positive number",
			});
		}
	}

	switch (chartType) {
		case "timeseries": {
			if (
				value.style !== undefined &&
				(typeof value.style !== "string" || !CHART_STYLES.has(value.style))
			) {
				errors.push({
					path: `${path}.style`,
					message: `Field 'style' must be one of: ${[...CHART_STYLES].join(", ")}`,
				});
			}
			if (!Array.isArray(value.series)) {
				errors.push({
					path: `${path}.series`,
					message: "Required field 'series' must be an array",
				});
			} else if (value.series.length === 0) {
				errors.push({
					path: `${path}.series`,
					message: "Field 'series' must not be empty",
				});
			} else {
				for (let i = 0; i < value.series.length; i++) {
					validateChartSeries(value.series[i], `${path}.series[${i}]`, errors);
				}
			}
			if (value.x_axis_name !== undefined && typeof value.x_axis_name !== "string") {
				errors.push({
					path: `${path}.x_axis_name`,
					message: "Field 'x_axis_name' must be a string if provided",
				});
			}
			if (value.y_axis_name !== undefined && typeof value.y_axis_name !== "string") {
				errors.push({
					path: `${path}.y_axis_name`,
					message: "Field 'y_axis_name' must be a string if provided",
				});
			}
			if (value.gradient !== undefined && typeof value.gradient !== "boolean") {
				errors.push({
					path: `${path}.gradient`,
					message: "Field 'gradient' must be a boolean if provided",
				});
			}
			break;
		}
		case "custom": {
			if (!isRecord(value.options)) {
				errors.push({
					path: `${path}.options`,
					message: "Required field 'options' must be an object",
				});
			}
			break;
		}
	}
}

function validateBlock(value: unknown, path: string, errors: ValidationError[]): void {
	if (!isRecord(value)) {
		errors.push({ path, message: "Block must be an object" });
		return;
	}

	const type = value.type;
	if (typeof type !== "string" || !BLOCK_TYPES.has(type)) {
		errors.push({
			path: `${path}.type`,
			message: `Unknown block type '${String(type)}'. Expected one of: ${[...BLOCK_TYPES].join(", ")}`,
		});
		return;
	}

	if (value.block_id !== undefined && typeof value.block_id !== "string") {
		errors.push({
			path: `${path}.block_id`,
			message: "Field 'block_id' must be a string if provided",
		});
	}

	switch (type) {
		case "header": {
			if (typeof value.text !== "string") {
				errors.push({
					path: `${path}.text`,
					message: "Required field 'text' must be a string",
				});
			}
			break;
		}
		case "section": {
			if (typeof value.text !== "string") {
				errors.push({
					path: `${path}.text`,
					message: "Required field 'text' must be a string",
				});
			}
			if (value.accessory !== undefined) {
				validateElement(value.accessory, `${path}.accessory`, errors);
			}
			break;
		}
		case "divider": {
			// No required fields
			break;
		}
		case "fields": {
			if (!Array.isArray(value.fields)) {
				errors.push({
					path: `${path}.fields`,
					message: "Required field 'fields' must be an array",
				});
			} else {
				for (let i = 0; i < value.fields.length; i++) {
					const f = value.fields[i] as unknown;
					if (!isRecord(f)) {
						errors.push({
							path: `${path}.fields[${i}]`,
							message: "Field entry must be an object",
						});
						continue;
					}
					if (typeof f.label !== "string") {
						errors.push({
							path: `${path}.fields[${i}].label`,
							message: "Required field 'label' must be a string",
						});
					}
					if (typeof f.value !== "string") {
						errors.push({
							path: `${path}.fields[${i}].value`,
							message: "Required field 'value' must be a string",
						});
					}
				}
			}
			break;
		}
		case "table": {
			if (!Array.isArray(value.columns)) {
				errors.push({
					path: `${path}.columns`,
					message: "Required field 'columns' must be an array",
				});
			} else {
				for (let i = 0; i < value.columns.length; i++) {
					const col = value.columns[i] as unknown;
					if (!isRecord(col)) {
						errors.push({
							path: `${path}.columns[${i}]`,
							message: "Column must be an object",
						});
						continue;
					}
					if (typeof col.key !== "string") {
						errors.push({
							path: `${path}.columns[${i}].key`,
							message: "Required field 'key' must be a string",
						});
					}
					if (typeof col.label !== "string") {
						errors.push({
							path: `${path}.columns[${i}].label`,
							message: "Required field 'label' must be a string",
						});
					}
					if (
						col.format !== undefined &&
						(typeof col.format !== "string" || !COLUMN_FORMATS.has(col.format))
					) {
						errors.push({
							path: `${path}.columns[${i}].format`,
							message: `Field 'format' must be one of: ${[...COLUMN_FORMATS].join(", ")}`,
						});
					}
					if (col.sortable !== undefined && typeof col.sortable !== "boolean") {
						errors.push({
							path: `${path}.columns[${i}].sortable`,
							message: "Field 'sortable' must be a boolean",
						});
					}
				}
			}
			if (!Array.isArray(value.rows)) {
				errors.push({
					path: `${path}.rows`,
					message: "Required field 'rows' must be an array",
				});
			} else {
				for (let i = 0; i < value.rows.length; i++) {
					if (!isRecord(value.rows[i] as unknown)) {
						errors.push({
							path: `${path}.rows[${i}]`,
							message: "Row must be an object",
						});
					}
				}
			}
			if (typeof value.page_action_id !== "string") {
				errors.push({
					path: `${path}.page_action_id`,
					message: "Required field 'page_action_id' must be a string",
				});
			}
			if (value.next_cursor !== undefined && typeof value.next_cursor !== "string") {
				errors.push({
					path: `${path}.next_cursor`,
					message: "Field 'next_cursor' must be a string if provided",
				});
			}
			if (value.empty_text !== undefined && typeof value.empty_text !== "string") {
				errors.push({
					path: `${path}.empty_text`,
					message: "Field 'empty_text' must be a string if provided",
				});
			}
			break;
		}
		case "actions": {
			if (!Array.isArray(value.elements)) {
				errors.push({
					path: `${path}.elements`,
					message: "Required field 'elements' must be an array",
				});
			} else {
				for (let i = 0; i < value.elements.length; i++) {
					validateElement(value.elements[i], `${path}.elements[${i}]`, errors);
				}
			}
			break;
		}
		case "stats": {
			if (!Array.isArray(value.items)) {
				errors.push({
					path: `${path}.items`,
					message: "Required field 'items' must be an array",
				});
			} else {
				for (let i = 0; i < value.items.length; i++) {
					const item = value.items[i] as unknown;
					if (!isRecord(item)) {
						errors.push({
							path: `${path}.items[${i}]`,
							message: "Stat item must be an object",
						});
						continue;
					}
					if (typeof item.label !== "string") {
						errors.push({
							path: `${path}.items[${i}].label`,
							message: "Required field 'label' must be a string",
						});
					}
					if (typeof item.value !== "string" && typeof item.value !== "number") {
						errors.push({
							path: `${path}.items[${i}].value`,
							message: "Required field 'value' must be a string or number",
						});
					}
					if (item.description !== undefined && typeof item.description !== "string") {
						errors.push({
							path: `${path}.items[${i}].description`,
							message: "Field 'description' must be a string",
						});
					}
					if (
						item.trend !== undefined &&
						(typeof item.trend !== "string" || !TREND_VALUES.has(item.trend))
					) {
						errors.push({
							path: `${path}.items[${i}].trend`,
							message: `Field 'trend' must be one of: ${[...TREND_VALUES].join(", ")}`,
						});
					}
				}
			}
			break;
		}
		case "form": {
			if (!Array.isArray(value.fields)) {
				errors.push({
					path: `${path}.fields`,
					message: "Required field 'fields' must be an array",
				});
			} else {
				for (let i = 0; i < value.fields.length; i++) {
					validateFormField(value.fields[i], `${path}.fields[${i}]`, errors);
				}
			}
			if (!isRecord(value.submit)) {
				errors.push({
					path: `${path}.submit`,
					message: "Required field 'submit' must be an object",
				});
			} else {
				if (typeof value.submit.label !== "string") {
					errors.push({
						path: `${path}.submit.label`,
						message: "Required field 'label' must be a string",
					});
				}
				if (typeof value.submit.action_id !== "string") {
					errors.push({
						path: `${path}.submit.action_id`,
						message: "Required field 'action_id' must be a string",
					});
				}
			}
			break;
		}
		case "image": {
			if (typeof value.url !== "string") {
				errors.push({
					path: `${path}.url`,
					message: "Required field 'url' must be a string",
				});
			}
			if (typeof value.alt !== "string") {
				errors.push({
					path: `${path}.alt`,
					message: "Required field 'alt' must be a string",
				});
			}
			if (value.title !== undefined && typeof value.title !== "string") {
				errors.push({
					path: `${path}.title`,
					message: "Field 'title' must be a string if provided",
				});
			}
			break;
		}
		case "context": {
			if (typeof value.text !== "string") {
				errors.push({
					path: `${path}.text`,
					message: "Required field 'text' must be a string",
				});
			}
			break;
		}
		case "columns": {
			if (!Array.isArray(value.columns)) {
				errors.push({
					path: `${path}.columns`,
					message: "Required field 'columns' must be an array",
				});
			} else if (value.columns.length < 2 || value.columns.length > 3) {
				errors.push({
					path: `${path}.columns`,
					message: "Field 'columns' must contain 2-3 column arrays",
				});
			} else {
				for (let i = 0; i < value.columns.length; i++) {
					const col = value.columns[i];
					if (!Array.isArray(col)) {
						errors.push({
							path: `${path}.columns[${i}]`,
							message: "Each column must be an array of blocks",
						});
						continue;
					}
					for (let j = 0; j < col.length; j++) {
						validateBlock(col[j], `${path}.columns[${i}][${j}]`, errors);
					}
				}
			}
			break;
		}
		case "chart": {
			validateChartConfig(value.config, `${path}.config`, errors);
			break;
		}
		case "meter": {
			if (typeof value.label !== "string") {
				errors.push({ path: `${path}.label`, message: "Required field 'label' must be a string" });
			}
			if (typeof value.value !== "number") {
				errors.push({ path: `${path}.value`, message: "Required field 'value' must be a number" });
			}
			if (value.max !== undefined && typeof value.max !== "number") {
				errors.push({ path: `${path}.max`, message: "Field 'max' must be a number if provided" });
			}
			if (value.min !== undefined && typeof value.min !== "number") {
				errors.push({ path: `${path}.min`, message: "Field 'min' must be a number if provided" });
			}
			if (
				typeof value.min === "number" &&
				typeof value.max === "number" &&
				value.min >= value.max
			) {
				errors.push({ path, message: "Field 'min' must be less than 'max'" });
			}
			if (value.custom_value !== undefined && typeof value.custom_value !== "string") {
				errors.push({
					path: `${path}.custom_value`,
					message: "Field 'custom_value' must be a string if provided",
				});
			}
			break;
		}
		case "code": {
			if (typeof value.code !== "string") {
				errors.push({ path: `${path}.code`, message: "Required field 'code' must be a string" });
			}
			if (
				value.language !== undefined &&
				(typeof value.language !== "string" || !CODE_LANGUAGES.has(value.language))
			) {
				errors.push({
					path: `${path}.language`,
					message: `Field 'language' must be one of: ${[...CODE_LANGUAGES].join(", ")}`,
				});
			}
			break;
		}
		case "banner": {
			if (value.title !== undefined && typeof value.title !== "string") {
				errors.push({
					path: `${path}.title`,
					message: "Field 'title' must be a string if provided",
				});
			}
			if (value.description !== undefined && typeof value.description !== "string") {
				errors.push({
					path: `${path}.description`,
					message: "Field 'description' must be a string if provided",
				});
			}
			if (value.title === undefined && value.description === undefined) {
				errors.push({
					path,
					message: "Banner must have at least 'title' or 'description'",
				});
			}
			if (
				value.variant !== undefined &&
				(typeof value.variant !== "string" || !BANNER_VARIANTS.has(value.variant))
			) {
				errors.push({
					path: `${path}.variant`,
					message: `Field 'variant' must be one of: ${[...BANNER_VARIANTS].join(", ")}`,
				});
			}
			break;
		}
		case "empty": {
			if (typeof value.title !== "string") {
				errors.push({
					path: `${path}.title`,
					message: "Required field 'title' must be a string",
				});
			}
			if (value.description !== undefined && typeof value.description !== "string") {
				errors.push({
					path: `${path}.description`,
					message: "Field 'description' must be a string if provided",
				});
			}
			if (value.command_line !== undefined && typeof value.command_line !== "string") {
				errors.push({
					path: `${path}.command_line`,
					message: "Field 'command_line' must be a string if provided",
				});
			}
			if (
				value.size !== undefined &&
				(typeof value.size !== "string" || !EMPTY_SIZES.has(value.size))
			) {
				errors.push({
					path: `${path}.size`,
					message: `Field 'size' must be one of: ${[...EMPTY_SIZES].join(", ")}`,
				});
			}
			if (value.actions !== undefined) {
				if (!Array.isArray(value.actions)) {
					errors.push({
						path: `${path}.actions`,
						message: "Field 'actions' must be an array if provided",
					});
				} else {
					for (let i = 0; i < value.actions.length; i++) {
						validateElement(value.actions[i], `${path}.actions[${i}]`, errors);
					}
				}
			}
			break;
		}
		case "accordion": {
			if (typeof value.label !== "string") {
				errors.push({
					path: `${path}.label`,
					message: "Required field 'label' must be a string",
				});
			}
			if (!Array.isArray(value.blocks)) {
				errors.push({
					path: `${path}.blocks`,
					message: "Required field 'blocks' must be an array",
				});
			} else {
				for (let i = 0; i < value.blocks.length; i++) {
					validateBlock(value.blocks[i], `${path}.blocks[${i}]`, errors);
				}
			}
			if (value.default_open !== undefined && typeof value.default_open !== "boolean") {
				errors.push({
					path: `${path}.default_open`,
					message: "Field 'default_open' must be a boolean if provided",
				});
			}
			break;
		}
	}
}

export function validateBlocks(blocks: unknown): {
	valid: boolean;
	errors: ValidationError[];
} {
	const errors: ValidationError[] = [];

	if (!Array.isArray(blocks)) {
		errors.push({ path: "blocks", message: "Blocks must be an array" });
		return { valid: false, errors };
	}

	for (let i = 0; i < blocks.length; i++) {
		validateBlock(blocks[i], `blocks[${i}]`, errors);
	}

	return { valid: errors.length === 0, errors };
}
