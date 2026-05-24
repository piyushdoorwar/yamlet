using Yamlet.App.Models;
using Yamlet.App.Services;
using Yamlet.App.ViewModels;

namespace Yamlet.Tests;

public class RequestEditorViewModelTests
{
    [Fact]
    public void OpensBodySectionWhenRequestHasBodyButNoEarlierValues()
    {
        var request = new YamletRequest
        {
            Name = "Create",
            Method = "POST",
            Url = "https://api.test/institutions",
            Body = new YamletRequestBody
            {
                Type = YamletBodyType.Json,
                Raw = "{\"name\":\"Test\"}",
            },
        };

        var editor = CreateEditor(request);

        Assert.Equal("Body", editor.SelectedRequestSection);
        Assert.True(editor.IsBodySection);
    }

    [Fact]
    public void OpensBodySectionWhenRequestHasBodyAndParams()
    {
        var request = new YamletRequest
        {
            Name = "List",
            Method = "GET",
            Url = "https://api.test/institutions",
            QueryParams = { new YamletQueryParam { Key = "page", Value = "1" } },
            Body = new YamletRequestBody
            {
                Type = YamletBodyType.Json,
                Raw = "{\"ignored\":\"because params are first\"}",
            },
        };

        var editor = CreateEditor(request);

        Assert.Equal("Body", editor.SelectedRequestSection);
        Assert.True(editor.IsBodySection);
    }

    private static RequestEditorViewModel CreateEditor(YamletRequest request)
    {
        var yaml = new YamlSerializationService();
        var requestFiles = new RequestFileService(yaml);
        var node = new RequestNodeViewModel
        {
            Request = request,
            OwningCollection = new YamletCollection { Name = "API" },
            Name = request.Name,
            Method = request.Method,
        };

        return new RequestEditorViewModel(
            node,
            RequestExecutor.CreateDefault(),
            requestFiles,
            _ => VariableContext.Empty);
    }
}
