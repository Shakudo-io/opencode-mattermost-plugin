/**
 * Question Card for AI Question Tool Support
 *
 * Adaptive Card builder for displaying AI questions with Input.ChoiceSet.
 * Supports single/multi-select, custom answers, and multi-question flows.
 */

import { CardFactory, type Attachment } from "botbuilder";
import { CardBuilder, type AdaptiveCardContent } from "./card-builder.js";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionCardConfig {
  questionId: string;
  sessionId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiple: boolean;
  custom?: boolean;
  questionIndex?: number;
  totalQuestions?: number;
}

/**
 * Builder for AI question cards with choice sets
 */
export class QuestionCardBuilder extends CardBuilder {
  constructor(private config: QuestionCardConfig) {
    super();
  }

  build(): AdaptiveCardContent {
    const card = this.createBaseCard();

    const headerText =
      this.config.totalQuestions && this.config.totalQuestions > 1
        ? `❓ ${this.config.header} (Question ${(this.config.questionIndex ?? 0) + 1}/${this.config.totalQuestions})`
        : `❓ ${this.config.header}`;

    card.body.push(
      this.textBlock(headerText, {
        size: "large",
        weight: "bolder",
        color: "accent",
      })
    );

    card.body.push(
      this.textBlock(this.config.question, {
        spacing: "medium",
      })
    );

    const choices = this.config.options.map((opt) => ({
      title: `${opt.label} - ${opt.description}`,
      value: opt.label,
    }));

    card.body.push(
      this.inputChoiceSet("selectedOptions", choices, {
        isMultiSelect: this.config.multiple,
        style: this.config.multiple ? "expanded" : "compact",
      })
    );

    if (this.config.custom !== false) {
      card.body.push(
        this.textBlock("Or type your own answer:", {
          size: "small",
          spacing: "medium",
          isSubtle: true,
        })
      );
      card.body.push(
        this.inputText("customAnswer", {
          placeholder: "Type your own answer...",
          isMultiline: false,
        })
      );
    }

    card.actions = [
      this.submitAction("Submit Answer", {
        verb: "answer_question",
        questionId: this.config.questionId,
        sessionId: this.config.sessionId,
      }),
      this.submitAction("Skip", {
        verb: "reject_question",
        questionId: this.config.questionId,
        sessionId: this.config.sessionId,
      }),
    ];

    return card;
  }
}

/**
 * Factory function to create a question card attachment
 */
export function createQuestionCard(config: QuestionCardConfig): Attachment {
  const builder = new QuestionCardBuilder(config);
  return builder.toAttachment();
}

/**
 * Factory function to create a question answered confirmation card
 */
export function createQuestionAnsweredCard(header: string, selectedOptions: string[]): Attachment {
  const card: AdaptiveCardContent = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "✅ Question Answered",
        size: "large",
        weight: "bolder",
        color: "good",
      },
      {
        type: "TextBlock",
        text: `**${header}**`,
        spacing: "medium",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: `Your answer: ${selectedOptions.join(", ")}`,
        spacing: "small",
        wrap: true,
        isSubtle: true,
      },
    ],
  };

  return CardFactory.adaptiveCard(card);
}

/**
 * Factory function to create a question rejected card
 */
export function createQuestionRejectedCard(header: string): Attachment {
  const card: AdaptiveCardContent = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "❌ Question Skipped",
        size: "large",
        weight: "bolder",
        color: "attention",
      },
      {
        type: "TextBlock",
        text: `**${header}**`,
        spacing: "medium",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "The AI will receive an empty response.",
        spacing: "small",
        wrap: true,
        isSubtle: true,
      },
    ],
  };

  return CardFactory.adaptiveCard(card);
}

/**
 * Factory function to create a question expired card
 */
export function createQuestionExpiredCard(header: string): Attachment {
  const card: AdaptiveCardContent = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "⏰ Question Expired",
        size: "large",
        weight: "bolder",
        color: "warning",
      },
      {
        type: "TextBlock",
        text: `**${header}**`,
        spacing: "medium",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "This question was not answered within 30 minutes and has expired.",
        spacing: "small",
        wrap: true,
        isSubtle: true,
      },
    ],
  };

  return CardFactory.adaptiveCard(card);
}
