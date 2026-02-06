import { CardFactory, type Attachment } from "botbuilder";

export type AdaptiveCardVersion = "1.3" | "1.4" | "1.5";

export interface CardAction {
  type: "Action.Submit" | "Action.OpenUrl" | "Action.ShowCard";
  title: string;
  data?: Record<string, unknown>;
  url?: string;
  card?: AdaptiveCardContent;
}

export interface AdaptiveCardContent {
  type: "AdaptiveCard";
  $schema: string;
  version: AdaptiveCardVersion;
  body: AdaptiveCardElement[];
  actions?: CardAction[];
}

export type AdaptiveCardElement =
  | TextBlockElement
  | ContainerElement
  | ColumnSetElement
  | FactSetElement
  | ImageElement
  | ActionSetElement
  | InputTextElement
  | InputChoiceSetElement;

export interface TextBlockElement {
  type: "TextBlock";
  text: string;
  size?: "small" | "default" | "medium" | "large" | "extraLarge";
  weight?: "lighter" | "default" | "bolder";
  color?: "default" | "dark" | "light" | "accent" | "good" | "warning" | "attention";
  wrap?: boolean;
  isSubtle?: boolean;
  separator?: boolean;
  spacing?: "none" | "small" | "default" | "medium" | "large" | "extraLarge" | "padding";
}

export interface ContainerElement {
  type: "Container";
  items: AdaptiveCardElement[];
  style?: "default" | "emphasis" | "good" | "attention" | "warning" | "accent";
  separator?: boolean;
  spacing?: "none" | "small" | "default" | "medium" | "large" | "extraLarge" | "padding";
}

export interface ColumnSetElement {
  type: "ColumnSet";
  columns: ColumnElement[];
  separator?: boolean;
  spacing?: "none" | "small" | "default" | "medium" | "large" | "extraLarge" | "padding";
}

export interface ColumnElement {
  type: "Column";
  width: "auto" | "stretch" | number;
  items: AdaptiveCardElement[];
}

export interface FactSetElement {
  type: "FactSet";
  facts: { title: string; value: string }[];
  separator?: boolean;
  spacing?: "none" | "small" | "default" | "medium" | "large" | "extraLarge" | "padding";
}

export interface ImageElement {
  type: "Image";
  url: string;
  altText?: string;
  size?: "auto" | "stretch" | "small" | "medium" | "large";
  horizontalAlignment?: "left" | "center" | "right";
}

export interface ActionSetElement {
  type: "ActionSet";
  actions: CardAction[];
}

export interface InputTextElement {
  type: "Input.Text";
  id: string;
  placeholder?: string;
  isMultiline?: boolean;
  maxLength?: number;
  value?: string;
}

export interface InputChoiceSetElement {
  type: "Input.ChoiceSet";
  id: string;
  choices: { title: string; value: string }[];
  value?: string;
  isMultiSelect?: boolean;
  style?: "compact" | "expanded";
}

export abstract class CardBuilder<T extends AdaptiveCardContent = AdaptiveCardContent> {
  protected version: AdaptiveCardVersion = "1.4";

  protected createBaseCard(): AdaptiveCardContent {
    return {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: this.version,
      body: [],
      actions: [],
    };
  }

  abstract build(): T;

  toAttachment(): Attachment {
    return CardFactory.adaptiveCard(this.build());
  }

  protected textBlock(
    text: string,
    options?: Partial<Omit<TextBlockElement, "type" | "text">>
  ): TextBlockElement {
    return {
      type: "TextBlock",
      text,
      wrap: true,
      ...options,
    };
  }

  protected container(
    items: AdaptiveCardElement[],
    options?: Partial<Omit<ContainerElement, "type" | "items">>
  ): ContainerElement {
    return {
      type: "Container",
      items,
      ...options,
    };
  }

  protected columnSet(
    columns: ColumnElement[],
    options?: Partial<Omit<ColumnSetElement, "type" | "columns">>
  ): ColumnSetElement {
    return {
      type: "ColumnSet",
      columns,
      ...options,
    };
  }

  protected column(
    width: "auto" | "stretch" | number,
    items: AdaptiveCardElement[]
  ): ColumnElement {
    return {
      type: "Column",
      width,
      items,
    };
  }

  protected factSet(
    facts: { title: string; value: string }[],
    options?: Partial<Omit<FactSetElement, "type" | "facts">>
  ): FactSetElement {
    return {
      type: "FactSet",
      facts,
      ...options,
    };
  }

  protected submitAction(title: string, data: Record<string, unknown>): CardAction {
    return {
      type: "Action.Submit",
      title,
      data,
    };
  }

  protected openUrlAction(title: string, url: string): CardAction {
    return {
      type: "Action.OpenUrl",
      title,
      url,
    };
  }

  protected inputText(
    id: string,
    options?: Partial<Omit<InputTextElement, "type" | "id">>
  ): InputTextElement {
    return {
      type: "Input.Text",
      id,
      ...options,
    };
  }

  protected inputChoiceSet(
    id: string,
    choices: { title: string; value: string }[],
    options?: Partial<Omit<InputChoiceSetElement, "type" | "id" | "choices">>
  ): InputChoiceSetElement {
    return {
      type: "Input.ChoiceSet",
      id,
      choices,
      ...options,
    };
  }

  protected truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }

  protected escapeMarkdown(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/\*/g, "\\*")
      .replace(/_/g, "\\_")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/`/g, "\\`");
  }
}
